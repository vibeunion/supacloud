// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import * as database from "../../src/db";
import { projectRepository } from "../../src/repositories/project.repository";
import { pgmqService } from "../../src/services/pgmq.service";
import { taskProjectFixture } from "../helpers/task-fixtures";
import { PgmqProjectContextError, readPgmqProjectDatabase } from "../../src/utils/pgmq-project";

const mapping = { ref: "proj_1", db_name: "custom_tenant_database", deleted_at: null };

test("project mapping must be explicit, current, identity-bound and a valid database name", () => {
  expect(readPgmqProjectDatabase(mapping, "proj_1")).toBe("custom_tenant_database");
  expect(readPgmqProjectDatabase({ ...mapping, db_name: 'Mixed database "name"' }, "proj_1")).toBe('Mixed database "name"');
  for (const value of [
    null, undefined, [], {}, { ...mapping, ref: "other" }, { ...mapping, deleted_at: undefined },
    { ...mapping, deleted_at: "2026-09-10" }, { ...mapping, db_name: undefined },
    { ...mapping, db_name: "" }, { ...mapping, db_name: " leading" },
    { ...mapping, db_name: "trailing " }, { ...mapping, db_name: "a\0b" },
    { ...mapping, db_name: "a\nb" }, { ...mapping, db_name: "x".repeat(64) },
    { ...mapping, db_name: "\u6570".repeat(22) },
  ]) expect(() => readPgmqProjectDatabase(value, "proj_1")).toThrow(PgmqProjectContextError);
  for (const ref of ["", "bad/ref", "proj_1 ", "x".repeat(129)]) {
    expect(() => readPgmqProjectDatabase({ ...mapping, ref }, ref)).toThrow(PgmqProjectContextError);
  }
});

const operations = (ref = "proj_1"): Array<() => Promise<unknown>> => [
  () => pgmqService.createQueue(ref, "jobs"),
  () => pgmqService.dropQueue(ref, "jobs"),
  () => pgmqService.listQueues(ref),
  () => pgmqService.listMessages(ref, "jobs"),
  () => pgmqService.send(ref, "jobs", {}),
  () => pgmqService.sendBatch(ref, "jobs", [{}]),
  () => pgmqService.read(ref, "jobs", 0, 1),
  () => pgmqService.pop(ref, "jobs"),
  () => pgmqService.archive(ref, "jobs", "1"),
  () => pgmqService.deleteMessage(ref, "jobs", "1"),
  () => pgmqService.setVisibilityTimeout(ref, "jobs", "1", 0),
  () => pgmqService.purge(ref, "jobs"),
  () => pgmqService.metrics(ref, "jobs"),
  () => pgmqService.metricsAll(ref),
];

test("every queue operation refuses absent, deleted, foreign or malformed project mappings", async () => {
  const find = spyOn(projectRepository, "findByRef");
  const connect = spyOn(database, "getProjectDb");
  const legacy = spyOn(database, "resolveDbName");
  try {
    for (const value of [null, { ...mapping, ref: "other" }, { ...mapping, deleted_at: "2026-09-10" },
      { ...mapping, db_name: "" }, { ...mapping, deleted_at: undefined }]) {
      // Deliberately inject malformed rows at the repository's unchecked runtime boundary.
      const wire: unknown = value;
      find.mockResolvedValue(wire as Awaited<ReturnType<typeof projectRepository.findByRef>>);
      for (const operation of operations()) {
        find.mockClear();
        await expect(operation()).rejects.toThrow(PgmqProjectContextError);
        expect(find).toHaveBeenCalledTimes(1);
        expect(find).toHaveBeenCalledWith("proj_1");
      }
    }
    expect(connect).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  } finally { find.mockRestore(); connect.mockRestore(); legacy.mockRestore(); }
});

test("repository failures are sanitized without falling back to generated database names", async () => {
  const find = spyOn(projectRepository, "findByRef").mockRejectedValue(new Error("secret SQL credentials"));
  const connect = spyOn(database, "getProjectDb");
  const legacy = spyOn(database, "resolveDbName");
  try {
    for (const operation of operations()) {
      find.mockClear();
      await expect(operation()).rejects.toThrow("PGMQ project database context is unavailable");
      expect(find).toHaveBeenCalledTimes(1);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  } finally { find.mockRestore(); connect.mockRestore(); legacy.mockRestore(); }
});

test("invalid project refs never query the repository or a tenant database", async () => {
  const find = spyOn(projectRepository, "findByRef");
  const connect = spyOn(database, "getProjectDb");
  try {
    for (const operation of operations("bad/ref")) {
      await expect(operation()).rejects.toThrow(PgmqProjectContextError);
    }
    expect(find).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally { find.mockRestore(); connect.mockRestore(); }
});

test("setup and queue query reuse one captured mapping and connection", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  const statements: string[] = [];
  let changed = false;
  // A SQL adapter fixture supplies query results; this does not implement PGMQ.
  const connection = new Proxy(sql, {
    apply(_target, _receiver, args: unknown[]) {
      const template = args[0];
      if (!Array.isArray(template) || !template.every((part: unknown) => typeof part === "string")) {
        throw new Error("Expected tagged SQL");
      }
      const text = template.join("?");
      statements.push(text);
      if (text.includes("CREATE EXTENSION")) {
        changed = true;
        return sql.unsafe("SELECT 1 WHERE 0");
      }
      if (text.includes("pgmq.send(")) return sql.unsafe("SELECT '9223372036854775807' AS msg_id");
      throw new Error("Unexpected SQL fixture statement");
    },
  });
  const project = taskProjectFixture({ ref: mapping.ref, db_name: mapping.db_name, deleted_at: null });
  const find = spyOn(projectRepository, "findByRef").mockImplementation(async () =>
    changed ? taskProjectFixture({ ...project, db_name: "other_database" }) : project);
  const connect = spyOn(database, "getProjectDb").mockReturnValue(connection);
  const legacy = spyOn(database, "resolveDbName");
  try {
    expect(await pgmqService.send("proj_1", "jobs", { value: 1 })).toBe("9223372036854775807");
    expect(find).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("custom_tenant_database");
    expect(legacy).not.toHaveBeenCalled();
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("CREATE EXTENSION");
    expect(statements[1]).toContain("pgmq.send(");
  } finally {
    find.mockRestore(); connect.mockRestore(); legacy.mockRestore();
    await sql.close();
  }
});

test("the service has no generated-name resolver or second mapping path", async () => {
  const source = await readFile(new URL("../../src/services/pgmq.service.ts", import.meta.url), "utf8");
  expect(source).not.toContain("resolveDbName");
  expect(source).not.toContain("ensurePgmq");
  expect(source.match(/projectRepository\.findByRef\(/g)).toHaveLength(1);
  expect(source.match(/getProjectDb\(/g)).toHaveLength(1);
  expect(source.match(/const db = await prepareProjectDb\(projectRef\)/g)).toHaveLength(14);
});

test("project mapping module compiles with strict full-library checking", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../../../supacloud-js/node_modules/.bin/tsc"), "--ignoreConfig",
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--skipLibCheck", "false", "--module", "ESNext", "--moduleResolution", "bundler",
      "--target", "ESNext", "--types", "node", join(import.meta.dir, "../../src/utils/pgmq-project.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
