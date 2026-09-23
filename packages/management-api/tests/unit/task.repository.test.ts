import { describe, expect, mock, spyOn, test } from "bun:test";
mock.restore();
const repo = await import("../../src/repositories/task.repository");

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

  test("buildTaskListQuery filters application task links", () => {
    const { sqlText, values } = buildTaskListQuery("proj_1", {
      correlationId: "workflow-123",
      businessTaskId: "fa-task-456",
      limit: 4,
    });

    expect(sqlText).toContain("correlation_id = $2");
    expect(sqlText).toContain("business_task_id = $3");
    expect(values).toEqual(["proj_1", "workflow-123", "fa-task-456", 4]);
  });

  test("buildTaskListQuery rejects conflicting DLQ status filters", () => {
    expect(() => buildTaskListQuery("proj_1", {
      statuses: ["failed"], onlyDeadLettered: true,
    })).toThrow("Invalid task list input");
    const { sqlText, values } = buildTaskListQuery("proj_1", {
      statuses: ["dead_lettered"],
      onlyDeadLettered: true,
      limit: 10,
    });

    expect(sqlText).toContain("status = 'dead_lettered'");
    expect(sqlText).not.toContain("status = ANY");
    expect(values).toEqual(["proj_1", 10]);
  });

  test("rejects invalid runtime list inputs before SQL and does not invoke getters", async () => {
    const { sql } = await import("../../src/db");
    const unsafe = spyOn(sql, "unsafe").mockResolvedValue([]);
    let reads = 0;
    const accessor = Object.defineProperty({}, "limit", { get() { reads++; return 1; } });
    const itemAccessor = Object.defineProperty(["pending"], "0", { get() { reads++; return "pending"; } });
    try {
      for (const filters of [
        null, [], "filters", accessor, { statuses: itemAccessor },
        { statuses: new Array(1) }, { statuses: [] }, { statuses: [1] },
        { taskTypes: "queue:one" }, { statuses: ["failed,pending"] },
        { functionSlug: "" }, { functionVersion: "\ud800" }, { summary: "false" },
        { onlyDeadLettered: 1 }, { extra: true },
        ...[0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "5"].map(limit => ({ limit })),
      ]) {
        const result: unknown = Reflect.apply(repo.listTasksByProjectFiltered, repo, ["proj_1", filters]);
        await expect(result).rejects.toThrow("Invalid task list input");
        expect(unsafe).not.toHaveBeenCalled();
      }
      for (const ref of ["", " padded", "bad\nref", "\ud800"]) {
        await expect(repo.listTasksByProject(ref)).rejects.toThrow("Invalid task list input");
        expect(unsafe).not.toHaveBeenCalled();
      }
      await expect(repo.listTasksByProject("proj_1", 0)).rejects.toThrow("Invalid task list input");
      expect(unsafe).not.toHaveBeenCalled();
      expect(reads).toBe(0);
    } finally { unsafe.mockRestore(); }
  });

  test("captures list SQL parameters once across a database retry", async () => {
    const { sql } = await import("../../src/db");
    const filters = { statuses: ["pending"], taskTypes: ["queue:one"], limit: 3 };
    const unsafe = spyOn(sql, "unsafe")
      .mockRejectedValueOnce(new Error("synthetic transient list failure"))
      .mockResolvedValue([]);
    try {
      const pending = repo.listTasksByProjectFiltered("proj_1", filters);
      filters.statuses[0] = "failed";
      filters.taskTypes.push("queue:two");
      filters.limit = 100;
      expect(await pending).toEqual([]);
      expect(unsafe).toHaveBeenCalledTimes(2);
      for (const call of unsafe.mock.calls) {
        expect(call[1]).toEqual(["proj_1", "pending", "queue:one", 3]);
      }
      expect(unsafe.mock.calls[0]?.[0]).toBe(unsafe.mock.calls[1]?.[0]);
    } finally { unsafe.mockRestore(); }
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
    const unsafe = mock(async (_query: string, _params: unknown[]) => [{
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
      { unsafe },
    )).resolves.toMatchObject({ count: 1 });

    const call = unsafe.mock.calls[0];
    if (!call) throw new Error("Expected an invoker query");
    const [query, params] = call;
    expect(query).toContain("WHERE auth_authority_ref = $1");
    expect(query).not.toContain("WHERE project_ref = $1");
    expect(query).toContain("BTRIM(payload->'auth'->>'invoker_user_id')");
    expect(params[0]).toBe("auth-owner");
  });
});
