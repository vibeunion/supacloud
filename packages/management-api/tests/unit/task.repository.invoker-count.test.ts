import { describe, expect, mock, test } from "bun:test";

const unsafe = mock(async (_sqlText: string, _params: unknown[]) => {
  throw new Error("sql.unsafe should be mocked per test");
});

mock.module("../../src/db", () => ({
  sql: {
    unsafe,
  },
  TaskStatus: {
    PENDING: "pending",
    LEASED: "leased",
    RUNNING: "running",
    RETRY_SCHEDULED: "retry_scheduled",
  },
}));

mock.module("../../src/utils/retry", () => ({
  withRetry: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));

const { countActiveTasksByInvoker } = await import(
  new URL("../../src/repositories/task.repository.ts?task-repository-invoker-count-test", import.meta.url).href
);

describe("TaskRepository.countActiveTasksByInvoker", () => {
  test("returns the total active count even when the task summary is capped at 100", async () => {
    unsafe.mockImplementation(async (_sqlText: string, _params: unknown[]) => {
      const rows = Array.from({ length: 100 }, (_, index) => ({
        count: 101,
        id: `task-${index + 1}`,
        task_type: "edge_function",
        status: "running",
      }));
      return rows;
    });

    const result = await countActiveTasksByInvoker("proj_1", "user_1");

    expect(result.count).toBe(101);
    expect(result.tasks).toHaveLength(100);
    expect(result.tasks[0]).toEqual({
      id: "task-1",
      task_type: "edge_function",
      status: "running",
    });
  });

  test("returns zero count when there are no active tasks", async () => {
    unsafe.mockImplementation(async () => []);

    const result = await countActiveTasksByInvoker("proj_1", "user_1");

    expect(result.count).toBe(0);
    expect(result.tasks).toEqual([]);
  });
});
