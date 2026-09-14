// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { Elysia } from "elysia";
import * as database from "../../src/db";
import { projectRepository } from "../../src/repositories/project.repository";
import { pgmqService } from "../../src/services/pgmq.service";
import { projectService } from "../../src/services";
import { PgmqMutationError } from "../../src/utils/pgmq-mutation";
import { taskProjectFixture } from "../helpers/task-fixtures";
import { withNativePostgres } from "../helpers/native-postgres";
import { taskRoutes } from "../../src/routes/tasks";
import { config } from "../../src/config";

const project = taskProjectFixture({ ref: "proj_1", db_name: "fixture", deleted_at: null });
const row = { msg_id: "1", read_ct: 1, enqueued_at: "2026-09-10T00:00:00Z", vt: "2026-09-10T00:01:00Z", message: {} };
const operations = [
  () => pgmqService.read("proj_1", "jobs", 60, 1),
  () => pgmqService.pop("proj_1", "jobs"),
  () => pgmqService.setVisibilityTimeout("proj_1", "jobs", "1", 0),
];

test("consume receipt and SQL failures are uncertain with exactly one dispatch", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  let output: unknown = [];
  let calls = 0;
  let fail = false;
  let setupFail = false;
  const db = new Proxy(sql, {
    apply(_target, _receiver, args: unknown[]) {
      if (Array.isArray(args[0]) && args[0].join("").includes("CREATE EXTENSION")) {
        if (setupFail) throw new Error("setup failure");
        return sql.unsafe("SELECT 1 WHERE 0");
      }
      calls++;
      if (fail) throw new Error("private SQL failure");
      return Promise.resolve(output);
    },
  });
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
  const connect = spyOn(database, "getProjectDb").mockReturnValue(db);
  try {
    for (const operation of operations) {
      for (const value of [null, {}, [{}], [row, row], [{ ...row, read_ct: -1 }],
        [{ ...row, vt: "bad" }], [{ ...row, message: undefined }]]) {
        calls = 0; output = value;
        await expect(operation()).rejects.toMatchObject({ name: "PgmqMutationError", mutationMayHaveApplied: true });
        expect(calls).toBe(1);
      }
      calls = 0; fail = true;
      await expect(operation()).rejects.toThrow("Queue mutation could not be confirmed");
      expect(calls).toBe(1);
      fail = false; setupFail = true; calls = 0;
      await expect(operation()).rejects.toThrow("setup failure");
      expect(calls).toBe(0);
      setupFail = false;
    }
    output = [{ ...row, msg_id: "2" }];
    await expect(pgmqService.setVisibilityTimeout("proj_1", "jobs", "1", 0)).rejects.toThrow(PgmqMutationError);
    output = [];
    expect(await operations[0]?.()).toEqual([]);
    expect(await operations[1]?.()).toBeNull();
    expect(await operations[2]?.()).toBeNull();
    output = [row];
    expect(await pgmqService.read("proj_1", "jobs", 60, 1)).toMatchObject([{ msg_id: "1", status: "leased" }]);
    expect(await pgmqService.pop("proj_1", "jobs")).toMatchObject({ msg_id: "1", status: "deleted" });
    expect(await pgmqService.setVisibilityTimeout("proj_1", "jobs", "1", 0)).toMatchObject({ msg_id: "1", status: "leased" });
  } finally { find.mockRestore(); connect.mockRestore(); await sql.close(); }
});

test("native committed visibility and deletion mutations survive malformed receipts", async () => {
  await withNativePostgres(async db => {
    await db`CREATE SCHEMA pgmq`;
    await db`CREATE TABLE pgmq.state (id integer PRIMARY KEY, changes integer NOT NULL DEFAULT 0)`;
    await db`INSERT INTO pgmq.state(id) VALUES (1), (2)`;
    await db.unsafe(`
      CREATE FUNCTION pgmq.read(q text, seconds integer, quantity integer)
      RETURNS TABLE(msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE pgmq.state SET changes = changes + 1 WHERE id = 1;
        RETURN QUERY SELECT 1::bigint, -1, NOW(), NOW(), '{}'::jsonb;
      END $$;
      CREATE FUNCTION pgmq.pop(q text)
      RETURNS TABLE(msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
      LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM pgmq.state WHERE id = 2;
        RETURN QUERY SELECT 2::bigint, -1, NOW(), NOW(), '{}'::jsonb;
      END $$;
      CREATE FUNCTION pgmq.set_vt(q text, id bigint, seconds integer)
      RETURNS TABLE(msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE pgmq.state SET changes = changes + 1 WHERE pgmq.state.id = 1;
        RETURN QUERY SELECT 99::bigint, 1, NOW(), NOW(), '{}'::jsonb;
      END $$;
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
      for (const operation of operations) await expect(operation()).rejects.toThrow(PgmqMutationError);
      const rows = await db`SELECT id, changes FROM pgmq.state ORDER BY id`;
      expect(Array.from(rows)).toEqual([{ id: 1, changes: 2 }]);
    } finally { find.mockRestore(); connect.mockRestore(); }
  });
}, 40_000);

test("actual consumption routes distinguish uncertain 503, setup 500 and legitimate empty results", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-consume-uncertainty";
  const read = spyOn(pgmqService, "read");
  const pop = spyOn(pgmqService, "pop");
  const release = spyOn(pgmqService, "setVisibilityTimeout");
  const settings = spyOn(projectService, "getQueueSettings").mockResolvedValue({
    max_in_flight: 10, default_visibility_timeout_sec: 330, max_attempts: 3, rate_limit_per_minute: 600,
  });
  const app = new Elysia().use(taskRoutes);
  const call = (path: string) => app.handle(new Request(
    `http://localhost/v1/projects/proj_1/tasks/queues/jobs/messages${path}`, {
      method: "POST", headers: { authorization: `Bearer ${config.masterToken}`, "content-type": "application/json" }, body: "{}",
    },
  ));
  try {
    for (const [path, spy] of [["/receive", read], ["/pop", pop], ["/1/release", release]] as const) {
      spy.mockRejectedValue(new PgmqMutationError());
      const uncertain = await call(path);
      expect(uncertain.status).toBe(503);
      expect(await uncertain.json()).toMatchObject({ code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
      spy.mockRejectedValue(new Error("private setup"));
      const failed = await call(path);
      expect(failed.status).toBe(500);
      const body = await failed.text();
      expect(body).not.toContain("private");
      expect(body).not.toContain("mutation_may_have_applied");
    }
    read.mockResolvedValue([]); pop.mockResolvedValue(null); release.mockResolvedValue(null);
    expect((await call("/receive")).status).toBe(204);
    expect((await call("/pop")).status).toBe(204);
    expect((await call("/1/release")).status).toBe(404);
  } finally { read.mockRestore(); pop.mockRestore(); release.mockRestore(); settings.mockRestore(); config.masterToken = previous; }
});
