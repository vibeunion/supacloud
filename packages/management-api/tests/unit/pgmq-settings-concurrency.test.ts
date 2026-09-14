// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { Elysia } from "elysia";
import { withNativePostgres } from "../helpers/native-postgres";
import { pgmqSettingsRepository } from "../../src/repositories/pgmq-settings.repository";
import { projectRepository } from "../../src/repositories/project.repository";
import { projectService } from "../../src/services";
import { taskProjectFixture } from "../helpers/task-fixtures";
import { PgmqSettingsConflictError, PgmqSettingsError } from "../../src/utils/pgmq-settings";
import { taskRoutes } from "../../src/routes/tasks";
import { config } from "../../src/config";

const settings = { max_in_flight: 10, default_visibility_timeout_sec: 330, max_attempts: 3, rate_limit_per_minute: 600 };
const project = taskProjectFixture({ ref: "proj_1", deleted_at: null, config: {} });

test("native PostgreSQL rejects stale and deleted snapshots and preserves unrelated config", async () => {
  await withNativePostgres(async db => {
    await db`CREATE TABLE projects (
      id text PRIMARY KEY, ref text UNIQUE NOT NULL, config jsonb NOT NULL,
      deleted_at timestamptz, updated_at timestamptz DEFAULT NOW()
    )`;
    const initial = { site_url: "https://example.test", scheduled_functions: { keep: true } };
    await db`INSERT INTO projects (id, ref, config) VALUES ('identity', 'proj_1', ${initial}::jsonb)`;
    const updates = await Promise.all([
      pgmqSettingsRepository.compareAndUpdate("proj_1", "identity", initial, { jobs: { ...settings, max_attempts: 4 } }, db),
      pgmqSettingsRepository.compareAndUpdate("proj_1", "identity", initial, { jobs: { ...settings, max_attempts: 5 } }, db),
    ]);
    expect(updates.filter(value => value !== null)).toHaveLength(1);
    expect(updates.filter(value => value === null)).toHaveLength(1);
    const rows = await db`SELECT config FROM projects WHERE ref = 'proj_1'`;
    expect(rows[0].config.site_url).toBe(initial.site_url);
    expect(rows[0].config.scheduled_functions).toEqual({ keep: true });
    const winner: Record<string, unknown> = rows[0].config;
    await db`UPDATE projects SET config = config || '{"concurrent":"preserve"}'::jsonb WHERE ref = 'proj_1'`;
    expect(await pgmqSettingsRepository.compareAndUpdate("proj_1", "identity", winner, { jobs: settings }, db)).toBeNull();
    expect(await pgmqSettingsRepository.compareAndUpdate("proj_1", "other-id", initial, {}, db)).toBeNull();
    const current = await db`SELECT config FROM projects WHERE ref = 'proj_1'`;
    await db`UPDATE projects SET deleted_at = NOW() WHERE ref = 'proj_1'`;
    expect(await pgmqSettingsRepository.compareAndUpdate("proj_1", "identity", current[0].config, {}, db)).toBeNull();
    const after = await db`SELECT config FROM projects WHERE ref = 'proj_1'`;
    expect(after[0].config).toEqual(current[0].config);
  });
}, 40_000);

test("repository dispatches once on failure and rejects malformed result cardinality", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  let calls = 0;
  let result: unknown = [];
  let fail = false;
  const db = new Proxy(sql, {
    apply() {
      calls++;
      if (fail) throw new Error("synthetic lost response");
      return Promise.resolve(result);
    },
  });
  try {
    fail = true;
    await expect(pgmqSettingsRepository.compareAndUpdate("proj_1", "id", {}, {}, db)).rejects.toThrow("synthetic lost response");
    expect(calls).toBe(1);
    fail = false;
    for (const value of [undefined, {}, [null], [project, project]]) {
      result = value;
      await expect(pgmqSettingsRepository.compareAndUpdate("proj_1", "id", {}, {}, db)).rejects.toThrow(PgmqSettingsError);
    }
    result = [];
    expect(await pgmqSettingsRepository.compareAndUpdate("proj_1", "id", {}, {}, db)).toBeNull();
  } finally { await sql.close(); }
});

test("service uses captured identity and snapshot, never the generic retrying config writer", async () => {
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
  const generic = spyOn(projectRepository, "updateConfig");
  const update = spyOn(pgmqSettingsRepository, "compareAndUpdate");
  try {
    update.mockResolvedValue({ ...project, config: { queue_settings: { jobs: settings } } });
    expect(await projectService.updateQueueSettings("proj_1", "jobs", {})).toEqual(settings);
    expect(update).toHaveBeenLastCalledWith("proj_1", project.id, {}, { jobs: settings });
    expect(find).toHaveBeenCalledTimes(1);
    update.mockResolvedValue(null);
    await expect(projectService.updateQueueSettings("proj_1", "jobs", {})).rejects.toThrow(PgmqSettingsConflictError);
    update.mockResolvedValue({ ...project, id: "foreign", config: { queue_settings: { jobs: settings } } });
    await expect(projectService.updateQueueSettings("proj_1", "jobs", {})).rejects.toMatchObject({ mutationMayHaveApplied: true });
    update.mockRejectedValue(new Error("private SQL"));
    update.mockClear();
    await expect(projectService.updateQueueSettings("proj_1", "jobs", {})).rejects.toMatchObject({ mutationMayHaveApplied: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(generic).not.toHaveBeenCalled();
  } finally { find.mockRestore(); generic.mockRestore(); update.mockRestore(); }
});

test("actual route distinguishes observed conflict from uncertain completion", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-settings-concurrency-token";
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
  const update = spyOn(pgmqSettingsRepository, "compareAndUpdate").mockResolvedValue(null);
  const app = new Elysia().use(taskRoutes);
  const request = () => app.handle(new Request("http://localhost/v1/projects/proj_1/tasks/queues/jobs/settings", {
    method: "PATCH", headers: { authorization: `Bearer ${config.masterToken}`, "content-type": "application/json" },
    body: JSON.stringify({ max_attempts: 4 }),
  }));
  try {
    const conflict = await request();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "PGMQ_SETTINGS_CONFLICT" });
    update.mockRejectedValue(new Error("private database detail"));
    const uncertain = await request();
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toEqual({
      message: "Queue settings update could not be confirmed",
      code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true,
    });
  } finally { find.mockRestore(); update.mockRestore(); config.masterToken = previous; }
});
