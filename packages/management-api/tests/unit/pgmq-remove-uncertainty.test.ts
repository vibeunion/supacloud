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

test("archive and delete preserve literal booleans and reject uncertain receipts without retry", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  let calls = 0;
  let output: unknown;
  let fail = false;
  let setupFail = false;
  const db = new Proxy(sql, {
    apply(_target, _receiver, args: unknown[]) {
      if (Array.isArray(args[0]) && args[0].join("").includes("CREATE EXTENSION")) {
        if (setupFail) throw new Error("setup failure");
        return sql.unsafe("SELECT 1 WHERE 0");
      }
      calls++;
      if (fail) throw new Error("private SQL details");
      return Promise.resolve(output);
    },
  });
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
  const connect = spyOn(database, "getProjectDb").mockReturnValue(db);
  try {
    for (const [field, operation] of [
      ["archived", () => pgmqService.archive("proj_1", "jobs", "1")],
      ["deleted", () => pgmqService.deleteMessage("proj_1", "jobs", "1")],
    ] as const) {
      for (const value of [null, [], [{}], [{ [field]: null }], [{ [field]: "false" }],
        [{ [field]: true }, { [field]: true }]]) {
        calls = 0; output = value;
        await expect(operation()).rejects.toMatchObject({
          name: "PgmqMutationError", mutationMayHaveApplied: true,
          message: "Queue mutation could not be confirmed",
        });
        expect(calls).toBe(1);
      }
      for (const value of [false, true]) {
        output = [{ [field]: value }];
        expect(await operation()).toBe(value);
      }
      fail = true; calls = 0;
      await expect(operation()).rejects.toThrow("Queue mutation could not be confirmed");
      expect(calls).toBe(1);
      fail = false; setupFail = true; calls = 0;
      await expect(operation()).rejects.toThrow("setup failure");
      expect(calls).toBe(0);
      setupFail = false;
    }
  } finally { find.mockRestore(); connect.mockRestore(); await sql.close(); }
});

test("native archive/delete commits survive a null receipt and are not replayed", async () => {
  await withNativePostgres(async db => {
    await db`CREATE SCHEMA pgmq`;
    await db`CREATE TABLE pgmq.pending (id bigint PRIMARY KEY)`;
    await db`CREATE TABLE pgmq.archived (id bigint PRIMARY KEY)`;
    await db`INSERT INTO pgmq.pending VALUES (1), (2)`;
    await db.unsafe(`
      CREATE FUNCTION pgmq.archive(q text, message_id bigint) RETURNS boolean
      LANGUAGE plpgsql AS $$
      BEGIN
        WITH removed AS (DELETE FROM pgmq.pending WHERE id = message_id RETURNING id)
        INSERT INTO pgmq.archived SELECT id FROM removed;
        RETURN NULL;
      END $$;
      CREATE FUNCTION pgmq.delete(q text, message_id bigint) RETURNS boolean
      LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM pgmq.pending WHERE id = message_id;
        RETURN NULL;
      END $$;
    `);
    let calls = 0;
    const connection = new Proxy(db, {
      apply(target, receiver, args: unknown[]) {
        if (Array.isArray(args[0]) && args[0].join("").includes("CREATE EXTENSION")) return db`SELECT 1 WHERE false`;
        calls++;
        return Reflect.apply(target, receiver, args);
      },
    });
    const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
    const connect = spyOn(database, "getProjectDb").mockReturnValue(connection);
    try {
      await expect(pgmqService.archive("proj_1", "jobs", "1")).rejects.toThrow(PgmqMutationError);
      await expect(pgmqService.deleteMessage("proj_1", "jobs", "2")).rejects.toThrow(PgmqMutationError);
      expect(calls).toBe(2);
      const pending = await db`SELECT id::text AS id FROM pgmq.pending`;
      const archived = await db`SELECT id::text AS id FROM pgmq.archived`;
      expect(Array.from(pending)).toEqual([]);
      expect(Array.from(archived)).toEqual([{ id: "1" }]);
    } finally { find.mockRestore(); connect.mockRestore(); }
  });
}, 40_000);

test("acknowledge, fail and delete routes distinguish uncertainty from confirmed false", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-remove-uncertainty";
  const archive = spyOn(pgmqService, "archive");
  const remove = spyOn(pgmqService, "deleteMessage");
  const app = new Elysia().use(taskRoutes);
  const call = (path: string, method: string) => app.handle(new Request(
    `http://localhost/v1/projects/proj_1/tasks/queues/jobs/messages/1${path}`, {
      method, headers: { authorization: `Bearer ${config.masterToken}` },
    },
  ));
  try {
    for (const [path, method, spy, falseStatus, trueStatus] of [
      ["/ack", "POST", archive, 409, 200], ["/fail", "POST", archive, 404, 200],
      ["", "DELETE", remove, 404, 204],
    ] as const) {
      spy.mockRejectedValue(new PgmqMutationError());
      const uncertain = await call(path, method);
      expect(uncertain.status).toBe(503);
      expect(await uncertain.json()).toMatchObject({ code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
      spy.mockRejectedValue(new Error("private setup details"));
      const failed = await call(path, method);
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain("private");
      spy.mockResolvedValue(false);
      expect((await call(path, method)).status).toBe(falseStatus);
      spy.mockResolvedValue(true);
      expect((await call(path, method)).status).toBe(trueStatus);
    }
  } finally { archive.mockRestore(); remove.mockRestore(); config.masterToken = previous; }
});
