// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";
import { InvalidTaskRecordError } from "../../src/utils/task-record";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native task JSON roundtrips and invalid write receipts do not replay updates",
  async () => withNativePostgres(async (database) => {
    const originalDb = await import("../../src/db");
    mock.module("../../src/db", () => ({ ...originalDb, sql: database }));
    const repo = await import("../../src/repositories/task.repository");
    const { enqueueBackgroundFunctionTask } = await import("../../src/services/background-task.service");
    // A driver contract fixture, not a production migration replay.
    await database.unsafe(`
      CREATE TABLE project_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_ref text NOT NULL,
        task_type text NOT NULL, status text DEFAULT 'pending', payload jsonb DEFAULT '{}',
        result jsonb, error text, retries integer DEFAULT 0, attempt integer DEFAULT 0,
        max_attempts integer DEFAULT 3, next_run_at timestamptz DEFAULT NOW(),
        lease_until timestamptz, started_at timestamptz, completed_at timestamptz,
        timeout_sec integer, idempotency_key text, trace_id text, cancel_requested_at timestamptz,
        cancellation_reason text, correlation_id text, business_task_id text, invoker_user_id uuid,
        auth_authority_ref text, metadata jsonb DEFAULT '{}', function_slug text, function_version text,
        created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW()
      );
      CREATE UNIQUE INDEX task_idempotency ON project_tasks(project_ref, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE TABLE project_task_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL,
        project_ref text NOT NULL, attempt_no integer NOT NULL, status text DEFAULT 'running',
        started_at timestamptz DEFAULT NOW(), completed_at timestamptz, duration_ms integer,
        error text, response_status integer, logs jsonb DEFAULT '[]',
        created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW(),
        UNIQUE(task_id, attempt_no)
      );
      CREATE TABLE task_writes (task_id uuid);
      CREATE FUNCTION count_task_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO task_writes VALUES (NEW.id);
        RETURN NEW;
      END $$;
      CREATE TRIGGER task_write AFTER UPDATE ON project_tasks
        FOR EACH ROW EXECUTE FUNCTION count_task_write();
    `);
    const payload = { zero: 0, disabled: false, empty: "", nested: { items: [null, "value"] } };
    const task = await repo.createTask({
      ref: "native", type: "queue:work", payload,
      metadata: { source: "native" }, correlationId: "correlation", businessTaskId: "business",
    });
    expect(task.payload).toEqual(payload);
    expect(task.created_at).toBeInstanceOf(Date);
    const encoding: unknown = await database`
      SELECT jsonb_typeof(payload) AS payload, jsonb_typeof(metadata) AS metadata
      FROM project_tasks WHERE id = ${task.id}::uuid
    `;
    expect(encoding).toEqual([{ payload: "object", metadata: "object" }]);
    expect((await repo.markTaskSucceeded(task.id, {}))?.result).toEqual({});
    const summary = await repo.listTasksByProjectFiltered("native", { summary: true });
    expect(summary).toHaveLength(1);
    expect(summary[0]?.correlation_id).toBe("correlation");
    expect(summary[0]?.business_task_id).toBe("business");
    expect(summary[0]?.metadata).toEqual({ source: "native" });
    expect(summary[0]?.payload).toEqual({});
    const attempt = await repo.startTaskAttempt({ ...task, attempt: 1 });
    expect(attempt.task_id).toBe(task.id);
    const logs = [{ timestamp: new Date(0).toISOString(), stream: "stdout" as const, level: "info", message: "done" }];
    const completed = await repo.completeTaskAttempt(task.id, 1, {
      status: "succeeded", durationMs: 0, responseStatus: 200, logs,
    });
    expect(completed?.logs).toEqual(logs);
    const logEncoding: unknown = await database`
      SELECT jsonb_typeof(logs) AS logs FROM project_task_attempts WHERE task_id = ${task.id}::uuid
    `;
    expect(logEncoding).toEqual([{ logs: "array" }]);

    const queued = await enqueueBackgroundFunctionTask({
      projectRef: "native", functionSlug: "work", traceId: "trace",
      timeoutSec: 300, maxAttempts: 3,
      envelope: {
        method: "PUT", path: "/item", query: "", headers: {}, body: "", body_encoding: "utf8",
        auth: { kind: "none" }, requested_timeout_sec: 300,
      },
    });
    expect(queued.payload.method).toBe("PUT");
    expect(queued.payload.body).toBe("");
    const queuedEncoding: unknown = await database`
      SELECT jsonb_typeof(payload) AS payload FROM project_tasks WHERE id = ${queued.id}::uuid
    `;
    expect(queuedEncoding).toEqual([{ payload: "object" }]);

    await database`UPDATE project_tasks SET payload = ${JSON.stringify(payload)}::jsonb WHERE id = ${task.id}::uuid`;
    expect((await repo.getTaskById(task.id))?.payload).toEqual(payload);
    await database`UPDATE project_tasks SET metadata = 'false'::jsonb WHERE id = ${task.id}::uuid`;
    await database`DELETE FROM task_writes`;
    await expect(repo.markTaskSucceeded(task.id, { written: true })).rejects.toBeInstanceOf(InvalidTaskRecordError);
    const writes: unknown = await database`
      SELECT COUNT(*)::int AS count FROM task_writes WHERE task_id = ${task.id}::uuid
    `;
    expect(writes).toEqual([{ count: 1 }]);
  }),
  40_000,
);
