import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import type { ProjectTask } from "../../src/db";
import { TaskStatus, TaskType } from "../../src/db";

const resolveDbName = mock(() => Promise.resolve("tenant_proj_mirror"));
const getProjectDb = mock(() => {
  throw new Error("getProjectDb should be mocked per test");
});
const loggerWarn = mock(() => undefined);

mock.module("../../src/db", () => ({
  resolveDbName,
  getProjectDb,
}));

mock.module("../../src/utils/logger", () => ({
  logger: {
    warn: loggerWarn,
  },
}));

const backgroundTaskServiceModule = await import(
  new URL("../../src/services/background-task.service.ts?background-task-service-test", import.meta.url).href
);

const {
  normalizeBackgroundTaskTimeout,
  normalizeBackgroundTaskMaxAttempts,
  createBackgroundTaskMirrorIfUserExists,
} = backgroundTaskServiceModule;

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    project_ref: "proj_mirror",
    task_type: TaskType.EDGE_FUNCTION,
    status: TaskStatus.PENDING,
    payload: {
      method: "POST",
      path: "/",
      query: "",
      headers: {},
      body: null,
      auth: {
        kind: "jwt",
        invoker_user_id: "00000000-0000-4000-8000-000000000100",
        invoker_role: "authenticated",
      },
    },
    error: null,
    retries: 0,
    attempt: 1,
    max_attempts: 3,
    next_run_at: new Date(),
    lease_until: null,
    started_at: null,
    completed_at: null,
    timeout_sec: 300,
    idempotency_key: null,
    trace_id: "trace_mirror",
    function_slug: "test-fn",
    function_version: null,
    result: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe("BackgroundTaskService: normalizeBackgroundTaskTimeout", () => {
  test("undefined returns default 300", () => {
    expect(normalizeBackgroundTaskTimeout(undefined)).toBe(300);
  });

  test("0 returns default 300", () => {
    expect(normalizeBackgroundTaskTimeout(0)).toBe(300);
  });

  test("NaN returns default 300", () => {
    expect(normalizeBackgroundTaskTimeout(NaN)).toBe(300);
  });

  test("Infinity returns default 300", () => {
    expect(normalizeBackgroundTaskTimeout(Infinity)).toBe(300);
  });

  test("negative value is clamped to 1", () => {
    expect(normalizeBackgroundTaskTimeout(-10)).toBe(1);
  });

  test("value exceeding 900 is clamped to 900", () => {
    expect(normalizeBackgroundTaskTimeout(2000)).toBe(900);
  });

  test("valid value 60 passes through", () => {
    expect(normalizeBackgroundTaskTimeout(60)).toBe(60);
  });

  test("exact boundary 900 passes through", () => {
    expect(normalizeBackgroundTaskTimeout(900)).toBe(900);
  });

  test("exact boundary 1 passes through", () => {
    expect(normalizeBackgroundTaskTimeout(1)).toBe(1);
  });

  test("float values are floored", () => {
    expect(normalizeBackgroundTaskTimeout(59.9)).toBe(59);
    expect(normalizeBackgroundTaskTimeout(300.7)).toBe(300);
  });
});

describe("BackgroundTaskService: normalizeBackgroundTaskMaxAttempts", () => {
  test("undefined returns default 3", () => {
    expect(normalizeBackgroundTaskMaxAttempts(undefined)).toBe(3);
  });

  test("0 returns default 3", () => {
    expect(normalizeBackgroundTaskMaxAttempts(0)).toBe(3);
  });

  test("NaN returns default 3", () => {
    expect(normalizeBackgroundTaskMaxAttempts(NaN)).toBe(3);
  });

  test("negative value is clamped to 1", () => {
    expect(normalizeBackgroundTaskMaxAttempts(-5)).toBe(1);
  });

  test("value exceeding 10 is clamped to 10", () => {
    expect(normalizeBackgroundTaskMaxAttempts(50)).toBe(10);
  });

  test("valid value 5 passes through", () => {
    expect(normalizeBackgroundTaskMaxAttempts(5)).toBe(5);
  });

  test("exact boundary 1 passes through", () => {
    expect(normalizeBackgroundTaskMaxAttempts(1)).toBe(1);
  });

  test("exact boundary 10 passes through", () => {
    expect(normalizeBackgroundTaskMaxAttempts(10)).toBe(10);
  });

  test("float values are floored", () => {
    expect(normalizeBackgroundTaskMaxAttempts(2.9)).toBe(2);
    expect(normalizeBackgroundTaskMaxAttempts(5.1)).toBe(5);
  });
});

describe("BackgroundTaskService: createBackgroundTaskMirrorIfUserExists", () => {
  let scenario: "table_exists" | "table_missing" | "user_missing" | "db_error" = "table_exists";

  const projectDb = mock((strings: TemplateStringsArray) => {
    const sql = strings.join(" ");
    if (sql.includes("to_regclass('public.background_task_mirrors')")) {
      if (scenario === "db_error") throw new Error("table check failed");
      return Promise.resolve([{ exists: scenario !== "table_missing" }]);
    }

    if (sql.includes("INSERT INTO public.background_task_mirrors")) {
      if (scenario === "db_error") throw new Error("mirror insert failed");
      if (scenario === "user_missing") return Promise.resolve([]);
      return Promise.resolve([{ id: "00000000-0000-4000-8000-000000000099" }]);
    }

    if (sql.includes("SELECT 1 FROM auth.users")) {
      return Promise.resolve(scenario === "user_missing" ? [] : [{ exists: 1 }]);
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  beforeEach(() => {
    scenario = "table_exists";
    resolveDbName.mockReset();
    getProjectDb.mockReset();
    loggerWarn.mockReset();
    resolveDbName.mockResolvedValue("tenant_proj_mirror");
    getProjectDb.mockReturnValue(projectDb as unknown as ReturnType<typeof getProjectDb>);
  });

  afterEach(() => {
    loggerWarn.mockReset();
  });

  test("returns inserted=true when the mirror table exists and the invoker user exists", async () => {
    scenario = "table_exists";

    const result = await createBackgroundTaskMirrorIfUserExists(makeTask());

    expect(result).toEqual({ inserted: true, userExists: true });
    expect(resolveDbName).toHaveBeenCalledWith("proj_mirror");
    expect(getProjectDb).toHaveBeenCalledWith("tenant_proj_mirror");
  });

  test("returns userExists=false when the invoker user is missing", async () => {
    scenario = "user_missing";

    const result = await createBackgroundTaskMirrorIfUserExists(makeTask());

    expect(result).toEqual({ inserted: false, userExists: false });
  });

  test("returns degraded=true when the mirror table is missing", async () => {
    scenario = "table_missing";

    const result = await createBackgroundTaskMirrorIfUserExists(makeTask());

    expect(result).toEqual({ inserted: false, userExists: true, degraded: true });
    expect(loggerWarn).toHaveBeenCalled();
  });

  test("short-circuits invalid invoker IDs without DB access", async () => {
    const result = await createBackgroundTaskMirrorIfUserExists(makeTask({
      payload: {
        method: "POST",
        path: "/",
        query: "",
        headers: {},
        body: null,
        auth: {
          kind: "jwt",
          invoker_user_id: "not-a-uuid",
          invoker_role: "authenticated",
        },
      },
    }));

    expect(result).toEqual({ inserted: false, userExists: true });
    expect(resolveDbName).not.toHaveBeenCalled();
    expect(getProjectDb).not.toHaveBeenCalled();
  });
});
