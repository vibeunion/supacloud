// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withNativePostgres } from "../helpers/native-postgres";
import { pipelineRequest } from "../helpers/pipeline";
import { PipelineError, readPipelineRow } from "../../src/utils/pipeline-contract";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native pipeline receipts preserve JSON and reject corrupt writes without replaying host actions",
  async () => withNativePostgres(async database => {
    const directory = await mkdtemp(join(tmpdir(), "supacloud-pipeline-native-"));
    const keys = [
      "PATH", "SUPACLOUD_PIPELINE_CONFIG_DIR", "SUPACLOUD_PIPELINE_RUNTIME_MODE",
      "SECRETS_ENCRYPTION_KEY", "FIXTURE_SYSTEMCTL_LOG", "FIXTURE_SYSTEMCTL_STATE",
      "FIXTURE_SYSTEMCTL_EXIT", "FIXTURE_SYSTEMCTL_STOP_EXIT",
    ] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const log = join(directory, "commands.log");
    const runtimeRoot = join(directory, "pipelines");
    const command = join(directory, "systemctl");
    await Bun.write(command, `#!/bin/sh
printf '%s %s\\n' "$1" "$2" >> "$FIXTURE_SYSTEMCTL_LOG"
if [ "$1" = "is-active" ]; then
  printf '%s\\n' "$FIXTURE_SYSTEMCTL_STATE"
  exit "\${FIXTURE_SYSTEMCTL_EXIT:-0}"
fi
exit "\${FIXTURE_SYSTEMCTL_STOP_EXIT:-0}"
`);
    await chmod(command, 0o700);
    process.env.PATH = `${directory}:${previous.PATH ?? "/usr/bin:/bin"}`;
    process.env.SUPACLOUD_PIPELINE_CONFIG_DIR = runtimeRoot;
    process.env.SUPACLOUD_PIPELINE_RUNTIME_MODE = "systemd";
    process.env.SECRETS_ENCRYPTION_KEY = "native-pipeline-fixture-key-0123456789abcdef";
    process.env.FIXTURE_SYSTEMCTL_LOG = log;
    process.env.FIXTURE_SYSTEMCTL_STATE = "active";
    process.env.FIXTURE_SYSTEMCTL_EXIT = "0";
    process.env.FIXTURE_SYSTEMCTL_STOP_EXIT = "0";
    await Bun.write(log, "");
    try {
      const originalDb = await import("../../src/db");
      mock.module("../../src/db", () => ({ ...originalDb, sql: database, getProjectDb: () => database }));
      const { pipelineService } = await import("../../src/services/pipeline.service");
      const ref = "fixture-project";
      const invalidInput = pipelineRequest();
      invalidInput.destination.service_account_key = "null";
      await expect(pipelineService.create(ref, invalidInput)).rejects.toBeInstanceOf(PipelineError);
      const schemaBeforeValidInput: unknown = await database`SELECT to_regclass('public.project_pipelines') AS relation`;
      expect(schemaBeforeValidInput).toEqual([{ relation: null }]);
      await database.unsafe(`
        CREATE TABLE projects (
          ref text PRIMARY KEY, db_name text, db_user text, db_password text, deleted_at timestamptz
        );
        INSERT INTO projects VALUES ('fixture-project', 'fixture', 'fixture', 'synthetic', NULL);
        CREATE TABLE fixture_source (id integer PRIMARY KEY, value text);
        CREATE PUBLICATION analytics_publication FOR TABLE fixture_source;
      `);
      const input = pipelineRequest();
      const created = await pipelineService.create(ref, input);
      expect(created).toMatchObject({ name: input.name, desired_state: "stopped", runtime_state: "unknown" });
      expect(created).not.toHaveProperty("destination_secret_encrypted");
      expect(created).not.toHaveProperty("runtime_id");
      const representations: unknown = await database`
        SELECT jsonb_typeof(settings) AS kind, settings FROM project_pipelines WHERE id = ${created.id}
      `;
      expect(representations).toEqual([{
        kind: "object", settings: { batch_wait_ms: 5000, sync_workers: 4, slot_recovery: "error" },
      }]);
      expect(await pipelineService.list(ref)).toEqual({ items: [created], total: 1 });
      const stored = readPipelineRow(await database`SELECT * FROM project_pipelines WHERE id = ${created.id}`, ref);
      if (!stored) throw new Error("Missing created pipeline");
      expect(stored.destination_secret_encrypted).not.toBe(input.destination.service_account_key);

      for (const fixture of [
        { state: "active", exit: "0", expected: "running" },
        { state: "inactive", exit: "3", expected: "stopped" },
        { state: "failed", exit: "3", expected: "failed" },
        { state: "active", exit: "1", expected: "unknown" },
        { state: "", exit: "1", expected: "unknown" },
      ]) {
        process.env.FIXTURE_SYSTEMCTL_STATE = fixture.state;
        process.env.FIXTURE_SYSTEMCTL_EXIT = fixture.exit;
        expect((await pipelineService.find(ref, created.id.toUpperCase())).public.runtime_state).toBe(fixture.expected);
      }
      await Bun.write(log, "");
      await database`UPDATE project_pipelines SET settings = ${{ sync_workers: "4" }} WHERE id = ${created.id}`;
      await expect(pipelineService.action(ref, created.id, "start")).rejects.toBeInstanceOf(PipelineError);
      expect(await Bun.file(log).text()).toBe("");
      await database`UPDATE project_pipelines SET settings = ${stored.settings}, destination_secret_encrypted = 'null' WHERE id = ${created.id}`;
      await expect(pipelineService.action(ref, created.id, "restart")).rejects.toBeInstanceOf(PipelineError);
      expect(await Bun.file(log).text()).toBe("");
      expect(await readdir(directory)).not.toContain("pipelines");
      await database`
        UPDATE project_pipelines SET destination_secret_encrypted = ${stored.destination_secret_encrypted},
          runtime_id = 9007199254740992 WHERE id = ${created.id}
      `;
      await expect(pipelineService.remove(ref, created.id)).rejects.toBeInstanceOf(PipelineError);
      expect(await Bun.file(log).text()).toBe("");
      await database`UPDATE project_pipelines SET runtime_id = ${stored.runtime_id} WHERE id = ${created.id}`;

      await database.unsafe(`
        CREATE FUNCTION corrupt_pipeline_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.destination_dataset_id := 'unexpected'; RETURN NEW; END $$;
        CREATE TRIGGER corrupt_pipeline_insert BEFORE INSERT ON project_pipelines
          FOR EACH ROW EXECUTE FUNCTION corrupt_pipeline_insert();
      `);
      await expect(pipelineService.create(ref, { ...input, name: "corrupt" })).rejects.toBeInstanceOf(PipelineError);
      const rejectedInsert: unknown = await database`SELECT id FROM project_pipelines WHERE name = 'corrupt'`;
      expect(rejectedInsert).toEqual([]);
      await database.unsafe("DROP TRIGGER corrupt_pipeline_insert ON project_pipelines");
      const zero = await pipelineService.create(ref, {
        ...input, name: "zero", batch_wait_ms: 0,
        destination: { ...input.destination, max_staleness_mins: 0 },
      });
      expect(zero.settings).toEqual({ batch_wait_ms: 0, sync_workers: 4, slot_recovery: "error", max_staleness_mins: 0 });

      await database.unsafe(`
        CREATE FUNCTION corrupt_pipeline_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.desired_state := 'running'; RETURN NEW; END $$;
        CREATE TRIGGER corrupt_pipeline_update BEFORE UPDATE ON project_pipelines
          FOR EACH ROW EXECUTE FUNCTION corrupt_pipeline_update();
      `);
      await expect(pipelineService.action(ref, created.id, "stop")).rejects.toBeInstanceOf(PipelineError);
      expect(await Bun.file(log).text()).toBe(`stop supacloud-pipeline@${stored.runtime_id}.service\n`);
      const rejectedUpdate: unknown = await database`SELECT desired_state FROM project_pipelines WHERE id = ${created.id}`;
      expect(rejectedUpdate).toEqual([{ desired_state: "stopped" }]);
      await database.unsafe("DROP TRIGGER corrupt_pipeline_update ON project_pipelines");

      await Bun.write(log, "");
      process.env.FIXTURE_SYSTEMCTL_STOP_EXIT = "1";
      await expect(pipelineService.remove(ref, created.id)).rejects.toThrow("Failed to stop");
      const retainedAfterStop: unknown = await database`SELECT id FROM project_pipelines WHERE id = ${created.id}`;
      expect(retainedAfterStop).toEqual([{ id: created.id }]);
      expect(await Bun.file(log).text()).toBe(`stop supacloud-pipeline@${stored.runtime_id}.service\n`);
      process.env.FIXTURE_SYSTEMCTL_STOP_EXIT = "0";
      await database.unsafe(`
        CREATE FUNCTION suppress_pipeline_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RETURN NULL; END $$;
        CREATE TRIGGER suppress_pipeline_delete BEFORE DELETE ON project_pipelines
          FOR EACH ROW EXECUTE FUNCTION suppress_pipeline_delete();
      `);
      await Bun.write(log, "");
      await expect(pipelineService.remove(ref, created.id)).rejects.toBeInstanceOf(PipelineError);
      expect(await Bun.file(log).text()).toBe(`stop supacloud-pipeline@${stored.runtime_id}.service\n`);
      const retainedAfterDelete: unknown = await database`SELECT id FROM project_pipelines WHERE id = ${created.id}`;
      expect(retainedAfterDelete).toEqual([{ id: created.id }]);
      await database.unsafe("DROP TRIGGER suppress_pipeline_delete ON project_pipelines");
      expect(await pipelineService.remove(ref, created.id.toUpperCase())).toEqual({ id: created.id, deleted: true });
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, { logicalReplication: true }),
  40_000,
);
