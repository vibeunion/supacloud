import { expect, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";
import { readPgflowState, setPgflowEnabled } from "../../src/services/pgflow.service";
import { executeSqlStatements } from "../../src/db/sql-statements";
import realtime from "../../../worker/tests/fixtures/realtime.sql" with { type: "text" };
import { roleNames } from "../../../worker/scripts/scheduler";
import { renderQueueGrants } from "../../../worker/scripts/roles";
import { loadMigrations } from "../../../worker/scripts/migrations";
import { PGFLOW_MIGRATIONS } from "../../src/db/pgflow-bundle";
import { createHash } from "node:crypto";

test("bundled migrations match the canonical shared installer byte for byte", async () => {
  const canonical = await loadMigrations("shared");
  expect(canonical.length).toBe(24);
  for (const migration of canonical) {
    const bundled = PGFLOW_MIGRATIONS.find(row => row.version === migration.version);
    expect(bundled?.sql).toBe(migration.sql);
    expect(bundled?.sha256).toBe(createHash("sha256").update(migration.sql).digest("hex"));
  }
});

test("canonical installation supports idempotent pause, preserves runs and denies worker bypass", async () => {
  await withNativePostgres(async db => {
    await executeSqlStatements(db, realtime);
    expect((await setPgflowEnabled(db, "project-one", true)).enabled).toBe(true);
    await db`SELECT pgflow.create_flow('scw_fixture')`;
    await db`SELECT pgflow.add_step('scw_fixture','first')`;
    const [run] = await db`SELECT * FROM pgflow.start_flow('scw_fixture','{}'::jsonb)`;
    expect(run.run_id).toBeDefined();
    await executeSqlStatements(db, renderQueueGrants("project-one").replace(/^\\set ON_ERROR_STOP on\s*/, ""));
    const worker = roleNames("project-one").worker;
    const id = crypto.randomUUID();
    await db`INSERT INTO pgflow.workers(worker_id,queue_name,function_name) VALUES(${id},'scw_fixture','fixture')`;
    await db.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE "${worker}"`);
      const [claim] = await tx`SELECT * FROM pgflow.start_tasks('scw_fixture',ARRAY[1]::bigint[],${id}::uuid)`;
      expect(claim.run_id).toBe(run.run_id);
    });
    const [pending] = await db`SELECT * FROM pgflow.start_flow('scw_fixture','{}'::jsonb)`;
    expect((await setPgflowEnabled(db, "project-one", false)).enabled).toBe(false);
    await expect((async () => { await db`SELECT * FROM pgflow.start_flow('scw_fixture','{}')`; })()).rejects.toThrow("PGFLOW_PAUSED");
    expect((await db`SELECT * FROM pgflow.start_tasks('scw_fixture',ARRAY[]::bigint[],gen_random_uuid())`).length).toBe(0);
    expect((await db`SELECT * FROM pgflow.runs`).length).toBe(2);
    await db.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE "${worker}"`);
      expect((await tx`SELECT * FROM pgflow.start_tasks('scw_fixture',ARRAY[2]::bigint[],${id}::uuid)`).length).toBe(0);
    });
    await db.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE "${worker}"`);
      await tx`SELECT * FROM pgflow.complete_task(${run.run_id}::uuid,'first',0,'{"done":true}')`;
    });
    const [finished] = await db`SELECT status FROM pgflow.runs WHERE run_id=${run.run_id}`;
    expect(finished.status).toBe("completed");
    const [permissions] = await db`SELECT has_table_privilege(${worker},'supacloud_worker.control','UPDATE') AS mutate,
      has_function_privilege(${worker},'pgflow.scw_start_tasks(text,bigint[],uuid)','EXECUTE') AS bypass`;
    expect(permissions.mutate).toBe(false);
    expect(permissions.bypass).toBe(false);
    expect((await setPgflowEnabled(db,"project-one",true)).enabled).toBe(true);
    await db.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE "${worker}"`);
      const [claimed] = await tx`SELECT * FROM pgflow.start_tasks('scw_fixture',ARRAY[2]::bigint[],${id}::uuid)`;
      expect(claimed.run_id).toBe(pending.run_id);
    });
    expect((await readPgflowState(db,"project-one")).version).toBe("0.16.0");
    await expect(readPgflowState(db,"other-project")).rejects.toThrow("binding");
    await db`UPDATE supacloud_worker.migrations SET sha256='invalid' WHERE version='supacloud_001'`;
    await expect(setPgflowEnabled(db,"project-one",false)).rejects.toThrow("checksum");
  }, { image: "ghcr.io/pgmq/pg18-pgmq:v1.10.0" });
}, 120_000);
