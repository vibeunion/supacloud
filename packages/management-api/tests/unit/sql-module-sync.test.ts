import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  SQL_MODULE_TARGETS,
  replaceSqlModuleBlock,
  sqlModuleMarker,
  syncSqlModules,
} from "../../src/db/sql-module-sync";
import { SQL_MODULES } from "../../src/db/sql-modules";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function markerFixture(moduleIds: readonly string[]): string {
  return moduleIds
    .map((moduleId) => `${sqlModuleMarker(moduleId, "start")}\nold ${moduleId}\n${sqlModuleMarker(moduleId, "end")}`)
    .join("\n\n") + "\n";
}

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/supacloud-sql-modules-");
  temporaryRoots.push(root);
  for (const target of SQL_MODULE_TARGETS) {
    const targetPath = join(root, target.relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, markerFixture(target.moduleIds), "utf8");
  }
  return root;
}

describe("canonical SQL module synchronization", () => {
  test("publishes the required security and RPC contracts", () => {
    expect(SQL_MODULES["auth-jwt-helpers"]).toContain("CREATE OR REPLACE FUNCTION auth.uid()");
    expect(SQL_MODULES["storage-path-helpers"]).toContain(
      "CREATE OR REPLACE FUNCTION storage.extension(name text)",
    );
    expect(SQL_MODULES["postgrest-request-context"]).toContain(
      "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog",
    );
    expect(SQL_MODULES["realtime-notify-payload"]).toContain(
      "CREATE OR REPLACE FUNCTION realtime.notify_change_payload(payload jsonb)",
    );
    expect(SQL_MODULES["pgmq-public"]).toContain(
      "CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)",
    );
    expect(SQL_MODULES["pgmq-public"]).toContain("SUPACLOUD_QUEUE_NAME_RESERVED");
    expect(SQL_MODULES["pgmq-public"]).toContain(
      "normalized_queue_name text := lower(btrim(queue_name))",
    );
    expect(SQL_MODULES["workflows-public"]).toContain(
      "CREATE OR REPLACE FUNCTION public.supacloud_workflow_start(request jsonb)",
    );
    expect(SQL_MODULES["workflows-public"]).toContain(
      "IF NOT pg_try_advisory_xact_lock(hashtextextended(candidate_run_id::text, 0))",
    );
    expect(SQL_MODULES["workflows-public"]).toContain("'messageId', queued_message.msg_id::text");
    expect(SQL_MODULES["workflows-public"]).toContain("'eventId', page.id::text");
    expect(SQL_MODULES["workflows-public"]).toContain("'operation', 'retry'");
    expect(SQL_MODULES["workflows-public"]).toContain(
      "REVOKE ALL ON FUNCTION public.supacloud_workflow_start(jsonb) FROM PUBLIC, anon, authenticated",
    );
    expect(SQL_MODULES["background-task-mirror-up"]).toContain(
      "CREATE TABLE IF NOT EXISTS public.background_task_mirrors",
    );
    expect(SQL_MODULES["background-task-mirror-up"]).toContain(
      "DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;",
    );
    expect(SQL_MODULES["background-task-mirror-down"]).toContain(
      "DROP TABLE IF EXISTS public.background_task_mirrors;",
    );
  });

  test("drops the legacy auth user fence before creating the background task mirror", () => {
    const upgradeSql = SQL_MODULES["background-task-mirror-up"];
    const upgradeStatements = [
      "DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;",
      "DROP FUNCTION IF EXISTS public.soft_delete_user_if_no_active_tasks();",
      "DROP FUNCTION IF EXISTS public.hard_delete_soft_deleted_users();",
      "DROP FUNCTION IF EXISTS public.has_active_background_tasks(UUID);",
      "CREATE TABLE IF NOT EXISTS public.background_task_mirrors",
    ];
    const upgradeOffsets = upgradeStatements.map((statement) => upgradeSql.indexOf(statement));
    expect(upgradeOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(upgradeOffsets).toEqual([...upgradeOffsets].sort((left, right) => left - right));

    const rollbackSql = SQL_MODULES["background-task-mirror-down"];
    const orderedStatements = [
      "DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;",
      "DROP FUNCTION IF EXISTS public.soft_delete_user_if_no_active_tasks();",
      "DROP FUNCTION IF EXISTS public.hard_delete_soft_deleted_users();",
      "DROP FUNCTION IF EXISTS public.has_active_background_tasks(UUID);",
      "DROP TABLE IF EXISTS public.background_task_mirrors;",
    ];

    const statementOffsets = orderedStatements.map((statement) => rollbackSql.indexOf(statement));
    expect(statementOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(statementOffsets).toEqual([...statementOffsets].sort((left, right) => left - right));
  });

  test("never reinstalls SupaCloud auth.users mutation logic", () => {
    for (const moduleId of ["background-task-mirror-up", "background-task-mirror-down"] as const) {
      const sql = SQL_MODULES[moduleId];
      expect(sql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(?:soft_delete_user_if_no_active_tasks|hard_delete_soft_deleted_users|has_active_background_tasks)/i);
      expect(sql).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+auth\.users/i);
      expect(sql).not.toContain("CREATE TRIGGER auth_users_delete_fence");
    }
  });

  test("keeps rollback from restoring the legacy delete fence", () => {
    const rollbackSql = SQL_MODULES["background-task-mirror-down"];
    expect(rollbackSql).toContain("DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;");
    expect(rollbackSql).not.toContain("CREATE TRIGGER auth_users_delete_fence");
    expect(rollbackSql).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+auth\.users/i);
  });

  test("does not hide failure while removing the legacy fence", () => {
    const upgradeSql = SQL_MODULES["background-task-mirror-up"];
    expect(upgradeSql).not.toContain("EXCEPTION WHEN OTHERS THEN NULL");
    expect(upgradeSql.indexOf("DROP TRIGGER IF EXISTS auth_users_delete_fence ON auth.users;"))
      .toBeLessThan(upgradeSql.indexOf("CREATE TABLE IF NOT EXISTS public.background_task_mirrors"));
  });

  test("replaces exactly one marked block and normalizes trailing newlines", () => {
    expect(sqlModuleMarker("demo", "start")).toBe("-- supacloud:sql-module:demo:start");
    const source = `${sqlModuleMarker("demo", "start")}\nold\n${sqlModuleMarker("demo", "end")}\n`;
    const replaced = replaceSqlModuleBlock(source, "demo", "new body\n\n");

    expect(replaced).toBe(
      `${sqlModuleMarker("demo", "start")}\nnew body\n${sqlModuleMarker("demo", "end")}\n`,
    );
  });

  test("rejects missing, duplicated, and reversed markers", () => {
    expect(() => replaceSqlModuleBlock("no markers", "demo", "body")).toThrow("exactly one");

    const start = sqlModuleMarker("demo", "start");
    const end = sqlModuleMarker("demo", "end");
    expect(() => replaceSqlModuleBlock(`${start}\n${start}\n${end}`, "demo", "body")).toThrow("exactly one");
    expect(() => replaceSqlModuleBlock(`${end}\n${start}`, "demo", "body")).toThrow("ordered");
  });

  test("fails check mode on drift, repairs it, then reports clean", async () => {
    const root = await createFixtureRoot();

    await expect(syncSqlModules({ repositoryRoot: root, check: true })).rejects.toThrow(
      "SQL module drift",
    );

    const repaired = await syncSqlModules({ repositoryRoot: root, check: false });
    expect(repaired.changedFiles).toHaveLength(SQL_MODULE_TARGETS.length);

    const clean = await syncSqlModules({ repositoryRoot: root, check: true });
    expect(clean).toEqual({ changedFiles: [] });

    const firstTarget = SQL_MODULE_TARGETS[0];
    const firstPath = join(root, firstTarget.relativePath);
    const synchronized = await readFile(firstPath, "utf8");
    expect(synchronized).toContain(SQL_MODULES[firstTarget.moduleIds[0]]);
  });

  test("reports a target with duplicate markers as an invalid source", async () => {
    const root = await createFixtureRoot();
    const target = SQL_MODULE_TARGETS[0];
    const targetPath = join(root, target.relativePath);
    const duplicate = `${markerFixture(target.moduleIds)}${sqlModuleMarker(target.moduleIds[0], "start")}\nextra\n${sqlModuleMarker(target.moduleIds[0], "end")}\n`;
    await writeFile(targetPath, duplicate, "utf8");

    await expect(syncSqlModules({ repositoryRoot: root, check: false })).rejects.toThrow("exactly one");
  });

  test("validates every target before writing any generated file", async () => {
    const root = await createFixtureRoot();
    const firstTarget = SQL_MODULE_TARGETS[0];
    const firstPath = join(root, firstTarget.relativePath);
    const before = await readFile(firstPath, "utf8");
    const lastTarget = SQL_MODULE_TARGETS.at(-1)!;
    const lastPath = join(root, lastTarget.relativePath);
    await writeFile(lastPath, "invalid target without markers\n", "utf8");

    await expect(syncSqlModules({ repositoryRoot: root, check: false })).rejects.toThrow("exactly one");
    expect(await readFile(firstPath, "utf8")).toBe(before);
  });

  test("keeps repository-generated targets synchronized", async () => {
    const repositoryRoot = resolve(import.meta.dir, "../../../..");

    await expect(syncSqlModules({ repositoryRoot, check: true })).resolves.toEqual({
      changedFiles: [],
    });
  });
});
