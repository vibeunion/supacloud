import { describe, expect, mock, test } from "bun:test";
mock.restore();
const repo = await import(
  new URL("../../src/repositories/task.repository.ts?task-repository-test", import.meta.url).href
);

const { buildTaskListQuery, retryTask } = repo;

describe("TaskRepository query builders", () => {
  test("buildTaskListQuery includes function_slug filter when provided", () => {
    const { sqlText, values } = buildTaskListQuery("proj_1", {
      functionSlug: "mockup-generator",
      limit: 8,
    });

    expect(sqlText).toContain("function_slug = $2");
    expect(values).toEqual(["proj_1", "mockup-generator", 8]);
  });

  test("buildTaskListQuery preserves status and task_type filters alongside function_slug", () => {
    const { sqlText, values } = buildTaskListQuery("proj_1", {
      statuses: ["failed", "dead_lettered"],
      taskTypes: ["edge_function"],
      functionSlug: "video-transcode",
      limit: 5,
    });

    expect(sqlText).toContain("status IN ($2, $3)");
    expect(sqlText).toContain("task_type IN ($4)");
    expect(sqlText).toContain("function_slug = $5");
    expect(values).toEqual([
      "proj_1",
      "failed",
      "dead_lettered",
      "edge_function",
      "video-transcode",
      5,
    ]);
  });

  test("buildTaskListQuery supports queue task type filters", () => {
    const { sqlText, values } = buildTaskListQuery("proj_1", {
      taskTypes: ["queue:emails"],
      statuses: ["pending", "leased"],
      limit: 20,
    });

    expect(sqlText).toContain("status IN ($2, $3)");
    expect(sqlText).toContain("task_type IN ($4)");
    expect(values).toEqual(["proj_1", "pending", "leased", "queue:emails", 20]);
  });

  test("buildTaskListQuery prefers explicit DLQ filter over statuses", () => {
    const { sqlText, values } = buildTaskListQuery("proj_1", {
      statuses: ["failed"],
      onlyDeadLettered: true,
      limit: 10,
    });

    expect(sqlText).toContain("status = 'dead_lettered'");
    expect(sqlText).not.toContain("status = ANY");
    expect(values).toEqual(["proj_1", 10]);
  });

  test("buildTaskListQuery can omit heavy payload columns for summary lists", () => {
    const { sqlText, values } = buildTaskListQuery("proj_1", {
      summary: true,
      limit: 25,
    });

    expect(sqlText).toContain("'{}'::jsonb AS payload");
    expect(sqlText).toContain("NULL::jsonb AS result");
    expect(sqlText).not.toContain("SELECT *");
    expect(values).toEqual(["proj_1", 25]);
  });

  test("claimNextTask caps project config by the worker host concurrency limit", () => {
    const source = repo.claimNextTask.toString();

    expect(source).toContain("options.concurrencyByProject");
    expect(source).toContain("LEAST(");
    expect(source).toContain("p.config->'background_tasks'->>'concurrency'");
  });

  test("retryTask only reactivates failed, dead-lettered, or cancelled tasks", () => {
    const source = retryTask.toString();

    expect(source).toContain("TaskStatuses.FAILED");
    expect(source).toContain("TaskStatuses.DEAD_LETTERED");
    expect(source).toContain("TaskStatuses.CANCELLED");
    expect(source).not.toContain("TaskStatuses.SUCCEEDED");
  });

  test("uses the authoritative invoker column with a validated rolling-upgrade fallback", () => {
    const source = repo.countActiveTasksByInvoker.toString();

    expect(source).toContain("invoker_user_id = $6::uuid");
    expect(source).toContain("payload_invoker_user_id = $6::uuid");
    expect(source).toContain("TASK_INVOKER_MISMATCH");
  });

  test("counts a whitespace-normalized invoker across every child of one auth authority", async () => {
    const unsafe = mock(async () => [{
      count: 1,
      id: "task-child",
      task_type: "edge_function",
      status: "running",
      invoker_consistent: true,
    }]);
    const userId = "00000000-0000-4000-8000-000000000001";

    await expect(repo.countActiveTasksByInvoker(
      "auth-owner",
      userId,
      { unsafe } as never,
    )).resolves.toMatchObject({ count: 1 });

    const [query, params] = unsafe.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("WHERE auth_authority_ref = $1");
    expect(query).not.toContain("WHERE project_ref = $1");
    expect(query).toContain("BTRIM(payload->'auth'->>'invoker_user_id')");
    expect(params[0]).toBe("auth-owner");
  });
});
