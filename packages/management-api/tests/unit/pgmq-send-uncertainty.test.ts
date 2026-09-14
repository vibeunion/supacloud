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

test("send failures and invalid receipts after dispatch are uncertain and never retried", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  let calls = 0;
  let output: unknown = [];
  let fail = false;
  const result = () => {
    calls++;
    if (fail) throw new Error("private connection detail");
    return Promise.resolve(output);
  };
  const db = new Proxy(sql, {
    apply(_target, _receiver, args: unknown[]) {
      if (Array.isArray(args[0]) && args[0].join("").includes("CREATE EXTENSION")) {
        return sql.unsafe("SELECT 1 WHERE 0");
      }
      return result();
    },
    get(target, key, receiver) {
      return key === "unsafe" ? result : Reflect.get(target, key, receiver);
    },
  });
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
  const connect = spyOn(database, "getProjectDb").mockReturnValue(db);
  try {
    for (const operation of [
      () => pgmqService.send("proj_1", "jobs", {}),
      () => pgmqService.sendBatch("proj_1", "jobs", [{}]),
    ]) {
      for (const value of [null, [], [{}], [{ msg_id: "0" }], [{ msg_id: "1" }, { msg_id: "1" }]]) {
        calls = 0;
        output = value;
        await expect(operation()).rejects.toMatchObject({
          name: "PgmqMutationError", mutationMayHaveApplied: true,
          message: "Queue mutation could not be confirmed",
        });
        expect(calls).toBe(1);
      }
      calls = 0;
      fail = true;
      await expect(operation()).rejects.toThrow("Queue mutation could not be confirmed");
      expect(calls).toBe(1);
      fail = false;
    }
    output = [{ msg_id: "1" }];
    expect(await pgmqService.send("proj_1", "jobs", {})).toBe("1");
    expect(await pgmqService.sendBatch("proj_1", "jobs", [{}])).toEqual(["1"]);
  } finally { find.mockRestore(); connect.mockRestore(); await sql.close(); }
});

test("setup failures are not mislabeled as possible message sends", async () => {
  const sql = new SQL(":memory:", { adapter: "sqlite" });
  const db = new Proxy(sql, { apply() { throw new Error("synthetic setup failure"); } });
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
  const connect = spyOn(database, "getProjectDb").mockReturnValue(db);
  try {
    for (const operation of [
      () => pgmqService.send("proj_1", "jobs", {}),
      () => pgmqService.sendBatch("proj_1", "jobs", [{}]),
    ]) {
      try {
        await operation();
        throw new Error("Expected setup failure");
      } catch (error) {
        expect(error).not.toBeInstanceOf(PgmqMutationError);
        expect(error).toMatchObject({ message: "synthetic setup failure" });
      }
    }
  } finally { find.mockRestore(); connect.mockRestore(); await sql.close(); }
});

test("native committed inserts remain present when service rejects invalid send receipts", async () => {
  await withNativePostgres(async db => {
    await db`CREATE SCHEMA pgmq`;
    await db`CREATE TABLE pgmq.received (id bigint GENERATED ALWAYS AS IDENTITY, message jsonb NOT NULL)`;
    await db.unsafe(`
      CREATE FUNCTION pgmq.send(q text, payload jsonb, delay integer)
      RETURNS bigint LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO pgmq.received(message) VALUES (payload);
        RETURN 0;
      END $$;
      CREATE FUNCTION pgmq.send_batch(q text, payloads jsonb[], delay integer)
      RETURNS SETOF bigint LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO pgmq.received(message) SELECT payload FROM unnest(payloads) AS payload;
        RETURN NEXT 1;
      END $$;
    `);
    const connection = new Proxy(db, {
      apply(target, receiver, args: unknown[]) {
        if (Array.isArray(args[0]) && args[0].join("").includes("CREATE EXTENSION")) {
          return db`SELECT 1 WHERE false`;
        }
        return Reflect.apply(target, receiver, args);
      },
      get(target, key) { return key === "unsafe" ? target.unsafe.bind(target) : Reflect.get(target, key, target); },
    });
    const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
    const connect = spyOn(database, "getProjectDb").mockReturnValue(connection);
    try {
      await expect(pgmqService.send("proj_1", "jobs", { value: "single" })).rejects.toThrow(PgmqMutationError);
      await expect(pgmqService.sendBatch("proj_1", "jobs", [{ value: "batch1" }, { value: "batch2" }])).rejects.toThrow(PgmqMutationError);
      const rows = await db`SELECT message FROM pgmq.received ORDER BY id`;
      expect(rows.map((row: { message: unknown }) => row.message)).toEqual([
        { value: "single" }, { value: "batch1" }, { value: "batch2" },
      ]);
    } finally { find.mockRestore(); connect.mockRestore(); }
  });
}, 40_000);

test("actual HTTP routes expose uncertain sends separately from setup errors", async () => {
  const previous = config.masterToken;
  config.masterToken = "synthetic-send-uncertainty";
  const send = spyOn(pgmqService, "send");
  const batch = spyOn(pgmqService, "sendBatch");
  const app = new Elysia().use(taskRoutes);
  const call = (path: string) => app.handle(new Request(
    `http://localhost/v1/projects/proj_1/tasks/queues/jobs/messages${path}`,
    { method: "POST", headers: { authorization: `Bearer ${config.masterToken}`, "content-type": "application/json" },
      body: JSON.stringify(path ? { messages: [{}] } : { message: {} }) },
  ));
  try {
    for (const [path, spy] of [["", send], ["/batch", batch]] as const) {
      spy.mockRejectedValue(new PgmqMutationError());
      const uncertain = await call(path);
      expect(uncertain.status).toBe(503);
      expect(await uncertain.json()).toMatchObject({ code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
      spy.mockRejectedValue(new Error("private setup detail"));
      const failed = await call(path);
      expect(failed.status).toBe(500);
      const text = await failed.text();
      expect(text).not.toContain("private");
      expect(text).not.toContain("mutation_may_have_applied");
    }
  } finally { send.mockRestore(); batch.mockRestore(); config.masterToken = previous; }
});
