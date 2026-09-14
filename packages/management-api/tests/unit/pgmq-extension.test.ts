// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import * as database from "../../src/db";
import { projectRepository } from "../../src/repositories/project.repository";
import { pgmqService } from "../../src/services/pgmq.service";
import { taskProjectFixture } from "../helpers/task-fixtures";
import { withNativePostgres } from "../helpers/native-postgres";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";

test("PGMQ 1.10.0 executes actual service create/send/read/archive/delete/metrics operations", async () => {
  await withNativePostgres(async db => {
    const find = spyOn(projectRepository, "findByRef").mockResolvedValue(
      taskProjectFixture({ ref: "proj_1", db_name: "fixture", deleted_at: null }));
    const connect = spyOn(database, "getProjectDb").mockReturnValue(db);
    try {
      await pgmqService.createQueue("proj_1", "jobs");
      await pgmqService.createQueue("proj_1", "fast", { unlogged: true });
      const version = await db`SELECT extversion FROM pg_extension WHERE extname = 'pgmq'`;
      expect(version[0].extversion).toBe("1.10.0");
      const queues = await pgmqService.listQueues("proj_1");
      expect(queues.find(queue => queue.queue_name === "jobs")).toMatchObject({ is_unlogged: false, is_partitioned: false });
      expect(queues.find(queue => queue.queue_name === "fast")).toMatchObject({ is_unlogged: true, is_partitioned: false });
      const first = await pgmqService.send("proj_1", "jobs", { nested: [1, false, null], text: '{"raw":true}' });
      expect(first).toBe("1");
      const batch = await pgmqService.sendBatch("proj_1", "jobs", [{ item: 2 }, { item: 3 }]);
      expect(batch).toEqual(["2", "3"]);
      const listing = await pgmqService.listMessages("proj_1", "jobs");
      expect(listing.map(row => row.msg_id)).toEqual(["3", "2", "1"]);
      const read = await pgmqService.read("proj_1", "jobs", 60, 1);
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({ msg_id: first, read_ct: 1, message: { nested: [1, false, null], text: '{"raw":true}' } });
      const released = await pgmqService.setVisibilityTimeout("proj_1", "jobs", first, 0);
      expect(released?.msg_id).toBe(first);
      expect(await pgmqService.archive("proj_1", "jobs", first)).toBe(true);
      expect(await pgmqService.archive("proj_1", "jobs", first)).toBe(false);
      const archived = await pgmqService.listMessages("proj_1", "jobs", { archived: true });
      expect(archived.map(row => row.msg_id)).toEqual([first]);
      expect(await pgmqService.deleteMessage("proj_1", "jobs", "2")).toBe(true);
      expect(await pgmqService.deleteMessage("proj_1", "jobs", "2")).toBe(false);
      const popped = await pgmqService.pop("proj_1", "jobs");
      expect(popped).toMatchObject({ msg_id: "3", message: { item: 3 }, status: "deleted" });
      expect(await pgmqService.pop("proj_1", "jobs")).toBeNull();
      expect(await pgmqService.read("proj_1", "jobs", 30, 1)).toEqual([]);
      expect(await pgmqService.metrics("proj_1", "jobs")).toMatchObject({ queue_name: "jobs", queue_length: 0 });
      expect((await pgmqService.metricsAll("proj_1")).some(queue => queue.queue_name === "jobs")).toBe(true);
      expect(await pgmqService.purge("proj_1", "jobs")).toBe(0);
      await pgmqService.sendBatch("proj_1", "jobs", [{ purge: 1 }, { purge: 2 }]);
      expect(await pgmqService.purge("proj_1", "jobs")).toBe(2);
      expect(await pgmqService.dropQueue("proj_1", "jobs")).toBe(true);
      expect(await pgmqService.dropQueue("proj_1", "fast")).toBe(true);
      expect(await pgmqService.listQueues("proj_1")).toEqual([]);
    } finally { find.mockRestore(); connect.mockRestore(); }
  }, { image });
}, 40_000);

test("real extension preserves high int64 ids and JSONB payloads across service calls", async () => {
  await withNativePostgres(async db => {
    const find = spyOn(projectRepository, "findByRef").mockResolvedValue(
      taskProjectFixture({ ref: "proj_1", db_name: "fixture", deleted_at: null }));
    const connect = spyOn(database, "getProjectDb").mockReturnValue(db);
    try {
      await pgmqService.createQueue("proj_1", "bigints");
      await db`SELECT setval(pg_get_serial_sequence('pgmq.q_bigints', 'msg_id'), 9007199254740992, true)`;
      const id = await pgmqService.send("proj_1", "bigints", { text: "original", values: [null, true, 1.5] });
      expect(id).toBe("9007199254740993");
      expect((await pgmqService.read("proj_1", "bigints", 60, 1))[0]).toMatchObject({
        msg_id: id, message: { text: "original", values: [null, true, 1.5] },
      });
      expect((await pgmqService.setVisibilityTimeout("proj_1", "bigints", id, 0))?.msg_id).toBe(id);
      expect(await pgmqService.deleteMessage("proj_1", "bigints", id)).toBe(true);
      expect(await pgmqService.dropQueue("proj_1", "bigints")).toBe(true);
    } finally { find.mockRestore(); connect.mockRestore(); }
  }, { image });
}, 40_000);
