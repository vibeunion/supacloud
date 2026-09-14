import { describe, expect, mock, test } from "bun:test";

const unsafe = mock(async (_sqlText: string, _params: unknown[]): Promise<unknown[]> => {
  throw new Error("sql.unsafe should be mocked per test");
});

const originalDb = await import("../../src/db");
mock.module("../../src/db", () => ({
  ...originalDb,
  sql: {
    unsafe,
  },
}));


const { countActiveTasksByInvoker } = await import("../../src/repositories/task.repository");

describe("TaskRepository.countActiveTasksByInvoker", () => {
  test("returns the total active count even when the task summary is capped at 100", async () => {
    unsafe.mockImplementation(async (_sqlText: string, _params: unknown[]) => {
      const rows = Array.from({ length: 100 }, (_, index) => ({
        count: 101,
        id: `task-${index + 1}`,
        task_type: "edge_function",
        status: "running",
        invoker_consistent: true,
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

  test("rejects invalid counts and identities instead of coercing a deletion-safety result", async () => {
    const valid = { count: 1, id: "task-1", task_type: "edge_function", status: "running", invoker_consistent: true };
    for (const patch of [{ count: "1" }, { count: -1 }, { count: 0 }, { id: null }, { status: "succeeded" }]) {
      unsafe.mockResolvedValue([{ ...valid, ...patch }]);
      await expect(countActiveTasksByInvoker("proj_1", "user_1")).rejects.toThrow("Invalid persisted task record");
    }
  });
});
