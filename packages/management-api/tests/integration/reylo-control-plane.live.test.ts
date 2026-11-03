import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

type ControlPlaneQueries = typeof import("../../src/db/reylo/queries")["queries"];
let queries: ControlPlaneQueries;

const databaseUrl = process.env.DATABASE_URL;
const describeLive = databaseUrl ? describe : describe.skip;
const ref = "reylo-live-test";
let db: SQL;
let taskId: string;

describeLive("Reylo control-plane production queries", () => {
  beforeAll(async () => {
    await import("reylo/register");
    ({ queries } = await import("../../src/db/reylo/queries"));
    db = new SQL(databaseUrl as string);
    await db`delete from projects where ref = ${ref}`;
    await db`
      insert into projects (ref, name, db_name, db_user, db_password, jwt_secret, anon_key, service_role_key, s3_bucket)
      values (${ref}, 'Reylo Live Test', 'reylo_live_test', 'reylo_live', 'password',
        'jwt-secret', 'anon-key', 'service-role-key', 'reylo-live-test')
    `;
    const [task] = await db`
      insert into project_tasks (
        project_ref, task_type, status, payload, attempt, max_attempts, next_run_at, error, auth_authority_ref
      )
      values (
        ${ref}, 'reylo.live', 'failed', ${JSON.stringify({ source: "reylo" })}::jsonb,
        1, 3, now(), 'reylo fixture failure', ${ref}
      )
      returning id
    `;
    taskId = String(task.id);
    await db`
      insert into project_task_attempts (task_id, project_ref, attempt_no, status, started_at, logs)
      values (${taskId}, ${ref}, 1, 'failed', now(), ${JSON.stringify([
        { timestamp: new Date().toISOString(), stream: "stdout", level: "info", message: "fixture" },
      ])}::jsonb)
    `;
  });

  afterAll(async () => {
    if (!db) return;
    await db`delete from projects where ref = ${ref}`;
    await db.close();
  });

  test("decodes a full task row through the canonical contract", async () => {
    const task = await queries.getTask(db, taskId, ref);
    expect(task).not.toBeNull();
    expect(task?.project_ref).toBe(ref);
    expect(task?.payload).toEqual({ source: "reylo" });
    expect(task?.created_at).toBeInstanceOf(Date);
  });

  test("task repository switches to Reylo when enabled", async () => {
    process.env.SUPACLOUD_REYLO_QUERIES = "1";
    const { taskRepository } = await import("../../src/repositories/task.repository");
    const task = await taskRepository.getTaskById(taskId, ref);
    expect(task?.payload).toEqual({ source: "reylo" });
    expect((await taskRepository.listTaskAttempts(taskId))[0]?.logs?.[0]?.message).toBe("fixture");
    expect((await taskRepository.getTaskStats(ref)).failedLast24h).toBe(1);
  });

  test("decodes attempts and aggregate statistics", async () => {
    const attempts = await queries.listTaskAttempts(db, taskId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.started_at).toBeInstanceOf(Date);
    expect(attempts[0]?.logs?.[0]?.message).toBe("fixture");

    const stats = await queries.getTaskStats(db, ref);
    expect(stats.failedLast24h).toBe(1);
    expect(stats.topFailures).toEqual([{ message: "reylo fixture failure", count: 1 }]);
    expect(stats.failedTrend.length).toBeGreaterThanOrEqual(1);
  });
});
