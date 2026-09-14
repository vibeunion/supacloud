// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { Elysia } from "elysia";
import * as database from "../../src/db";
import { projectRepository } from "../../src/repositories/project.repository";
import { pgmqService } from "../../src/services/pgmq.service";
import { PgmqMutationError } from "../../src/utils/pgmq-mutation";
import { taskProjectFixture } from "../helpers/task-fixtures";
import { withNativePostgres } from "../helpers/native-postgres";
import { taskRoutes } from "../../src/routes/tasks";
import { config } from "../../src/config";

const project = taskProjectFixture({ ref: "proj_1", db_name: "fixture", deleted_at: null });
const info = { queue_name: "jobs", created_at: new Date(0), is_partitioned: false, is_unlogged: false };

test("create requires one matching queue of the requested type on the same connection", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  let output: unknown = [info];
  let creates = 0;
  let reads = 0;
  let failAt = "";
  const statements: string[] = [];
  const db = new Proxy(sql, {
    apply(_target, _receiver, args: unknown[]) {
      if (!Array.isArray(args[0])) throw new Error("Expected tagged SQL");
      const text = args[0].join("?");
      statements.push(text);
      if (text.includes("CREATE EXTENSION")) {
        if (failAt === "setup") throw new Error("setup failure");
        return sql.unsafe("SELECT 1 WHERE 0");
      }
      if (text.includes("list_queues")) {
        reads++;
        expect(args[1]).toBe("jobs");
        if (failAt === "read") throw new Error("private readback detail");
        return Promise.resolve(output);
      }
      creates++;
      if (failAt === "create") throw new Error("private create detail");
      return sql.unsafe("SELECT 1 WHERE 0");
    },
  });
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
  const connect = spyOn(database, "getProjectDb").mockReturnValue(db);
  try {
    for (const unlogged of [false, true]) {
      output = [{ ...info, is_unlogged: unlogged }];
      creates = 0; reads = 0; statements.length = 0;
      find.mockClear(); connect.mockClear();
      await pgmqService.createQueue("proj_1", "jobs", { unlogged });
      expect(creates).toBe(1);
      expect(reads).toBe(1);
      expect(find).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(statements[1]).toContain(unlogged ? "create_unlogged" : "pgmq.create(");
    }
    for (const value of [null, [], [info, info], [{ ...info, queue_name: "other" }],
      [{ ...info, is_unlogged: true }], [{ ...info, is_partitioned: true }],
      [{ ...info, is_unlogged: "false" }]]) {
      output = value; creates = 0; reads = 0;
      await expect(pgmqService.createQueue("proj_1", "jobs")).rejects.toThrow(PgmqMutationError);
      expect(creates).toBe(1);
      expect(reads).toBe(1);
    }
    for (const phase of ["create", "read"]) {
      failAt = phase; creates = 0; reads = 0;
      await expect(pgmqService.createQueue("proj_1", "jobs")).rejects.toThrow("Queue mutation could not be confirmed");
      expect(creates).toBe(1);
      expect(reads).toBe(phase === "read" ? 1 : 0);
    }
    failAt = "setup"; creates = 0;
    await expect(pgmqService.createQueue("proj_1", "jobs")).rejects.toThrow("setup failure");
    expect(creates).toBe(0);
  } finally { find.mockRestore(); connect.mockRestore(); await sql.close(); }
});

test("native committed creation is not reported as success when type readback disagrees", async () => {
  await withNativePostgres(async db => {
    await db`CREATE SCHEMA pgmq`;
    await db`CREATE TABLE pgmq.fixture_queues (
      queue_name text PRIMARY KEY, created_at timestamptz DEFAULT NOW(),
      is_partitioned boolean DEFAULT false, is_unlogged boolean NOT NULL
    )`;
    await db.unsafe(`
      CREATE FUNCTION pgmq.create(q text) RETURNS void LANGUAGE sql AS $$
        INSERT INTO pgmq.fixture_queues(queue_name, is_unlogged) VALUES (q, false)
        ON CONFLICT DO NOTHING
      $$;
      CREATE FUNCTION pgmq.create_unlogged(q text) RETURNS void LANGUAGE sql AS $$
        INSERT INTO pgmq.fixture_queues(queue_name, is_unlogged) VALUES (q, true)
        ON CONFLICT DO NOTHING
      $$;
      CREATE FUNCTION pgmq.list_queues() RETURNS SETOF pgmq.fixture_queues LANGUAGE sql AS $$
        SELECT * FROM pgmq.fixture_queues
      $$;
    `);
    const connection = new Proxy(db, {
      apply(target, receiver, args: unknown[]) {
        if (Array.isArray(args[0]) && args[0].join("").includes("CREATE EXTENSION")) return db`SELECT 1 WHERE false`;
        return Reflect.apply(target, receiver, args);
      },
    });
    const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
    const connect = spyOn(database, "getProjectDb").mockReturnValue(connection);
    try {
      await pgmqService.createQueue("proj_1", "jobs");
      await expect(pgmqService.createQueue("proj_1", "jobs", { unlogged: true })).rejects.toThrow(PgmqMutationError);
      await pgmqService.createQueue("proj_1", "fast", { unlogged: true });
      const rows = await db`SELECT queue_name, is_unlogged FROM pgmq.fixture_queues ORDER BY queue_name`;
      expect(Array.from(rows)).toEqual([{ queue_name: "fast", is_unlogged: true }, { queue_name: "jobs", is_unlogged: false }]);
    } finally { find.mockRestore(); connect.mockRestore(); }
  });
}, 40_000);

test("actual create route returns uncertainty and sanitizes setup failure", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-create-confirmation";
  const create = spyOn(pgmqService, "createQueue");
  const app = new Elysia().use(taskRoutes);
  const request = () => app.handle(new Request("http://localhost/v1/projects/proj_1/tasks/queues", {
    method: "POST", headers: { authorization: `Bearer ${config.masterToken}`, "content-type": "application/json" },
    body: JSON.stringify({ queue_name: "jobs", unlogged: true }),
  }));
  try {
    create.mockRejectedValue(new PgmqMutationError());
    const uncertain = await request();
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toMatchObject({ code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
    create.mockRejectedValue(new Error("private setup details"));
    const failed = await request();
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private");
    create.mockResolvedValue(undefined);
    const success = await request();
    expect(success.status).toBe(201);
    expect(await success.json()).toEqual({ queue_name: "jobs", type: "unlogged" });
  } finally { create.mockRestore(); config.masterToken = previous; }
});
