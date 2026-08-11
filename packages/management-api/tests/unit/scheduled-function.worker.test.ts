import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  isDue,
  scheduledFunctionsDueAt,
  scheduledFunctionWorker,
} from "../../src/workers/scheduled-function.worker";
import { projectRepository } from "../../src/repositories/project.repository";
import { MAX_SCHEDULE_BODY_BYTES } from "../../src/utils/scheduled-function-config";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function scheduleConfig(
  headers: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Test",
    slug: "worker",
    cron: "* * * * *",
    method: "POST" as const,
    headers,
    enabled: true,
    created_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("scheduled-function cron parser (isDue)", () => {
  test("wildcard expression fires every minute", () => {
    const date = new Date("2026-06-15T10:30:00Z");
    expect(isDue("* * * * *", date)).toBe(true);
  });

  test("specific minute and hour matches", () => {
    const date = new Date("2026-06-15T10:30:00Z");
    // local timezone interpretation is fine; test a minute that exists
    expect(isDue("30 10 * * *", date)).toBe(true);
    expect(isDue("31 10 * * *", date)).toBe(false);
  });

  test("comma list matches", () => {
    const date = new Date("2026-06-15T10:15:00Z");
    expect(isDue("0,15,30,45 * * * *", date)).toBe(true);
  });

  test("step expression matches", () => {
    const date = new Date("2026-06-15T10:10:00Z");
    expect(isDue("*/10 * * * *", date)).toBe(true);
    const off = new Date("2026-06-15T10:07:00Z");
    expect(isDue("*/10 * * * *", off)).toBe(false);
  });

  test("range matches", () => {
    const inRange = new Date("2026-06-15T09:00:00Z");
    expect(isDue("0 0-10 * * *", inRange)).toBe(true);
    const outOfRange = new Date("2026-06-15T15:00:00Z");
    expect(isDue("0 0-10 * * *", outOfRange)).toBe(false);
  });

  test("day-of-week: 0 and 7 both mean Sunday", () => {
    // 2026-06-14 is a Sunday
    const sunday = new Date("2026-06-14T10:00:00Z");
    expect(isDue("0 10 * * 0", sunday)).toBe(true);
    expect(isDue("0 10 * * 7", sunday)).toBe(true);
    expect(isDue("0 10 * * 1", sunday)).toBe(false);
  });

  test("dom and dow OR semantics when both restricted", () => {
    // 2026-06-15 is a Monday (dow=1), dom=15
    const date = new Date("2026-06-15T10:00:00Z");
    // dom=15 matches even though dow=2 (Tuesday) doesn't
    expect(isDue("0 10 15 * 2", date)).toBe(true);
    // dom=14 won't match but dow=1 (Monday) does
    expect(isDue("0 10 14 * 1", date)).toBe(true);
    // neither matches
    expect(isDue("0 10 14 * 3", date)).toBe(false);
  });

  test.each([
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * 32 * *",
    "* * * 13 *",
    "* * * * 8",
    "0-999999999 * * * *",
    "*/999999999 * * * *",
    "59-0 * * * *",
    "*/0 * * * *",
    "0,,1 * * * *",
  ])("rejects invalid or unbounded expression %s", (expression) => {
    expect(isDue(expression, new Date("2026-06-15T10:00:00Z"))).toBe(false);
  });

  test("rejects an adversarial range within a hard process deadline", async () => {
    let timedOut = false;
    const child = Bun.spawn([
      process.execPath,
      "-e",
      'import { isDue } from "./src/workers/scheduled-function.worker.ts";'
        + 'if (isDue("0-999999999 * * * *", new Date())) process.exit(1);',
    ], {
      cwd: PACKAGE_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 1_000);
    const exitCode = await child.exited;
    clearTimeout(timeout);

    expect(timedOut).toBe(false);
    expect(exitCode).toBe(0);
  }, 2_000);

  test("invalid expression returns false", () => {
    const date = new Date("2026-06-15T10:00:00Z");
    expect(isDue("not a cron", date)).toBe(false);
    expect(isDue("* * *", date)).toBe(false);
  });
});

describe("scheduled-function selection", () => {
  test("reads canonical schedules from JSON-string project config", () => {
    const now = new Date("2026-06-15T10:30:00Z");
    const due = scheduledFunctionsDueAt([
      {
        ref: "proj_1",
        config: JSON.stringify({
          scheduled_functions: [
            scheduleConfig({}, {
              name: "Every minute",
              slug: "cleanup",
            }),
          ],
        }),
      },
    ], now);

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ ref: "proj_1", schedule: { slug: "cleanup" } });
  });

  test("skips an invalid legacy schedule without blocking valid schedules", () => {
    const due = scheduledFunctionsDueAt([{
      ref: "proj_1",
      config: {
        scheduled_functions: [
          scheduleConfig({}, {
            id: "00000000-0000-4000-8000-000000000002",
            name: "Invalid",
            slug: "invalid",
            cron: "0-999999999 * * * *",
          }),
          scheduleConfig({}, { name: "Valid", slug: "valid" }),
        ],
      },
    }], new Date("2026-06-15T10:30:00Z"));

    expect(due).toHaveLength(1);
    expect(due[0].schedule.slug).toBe("valid");
  });

  test.each([
    ["empty name", { name: "" }],
    ["overlong name", { name: "x".repeat(121) }],
    ["overlong slug", { slug: "x".repeat(129) }],
  ])("skips a schedule with %s", (_label, invalidFields) => {
    const due = scheduledFunctionsDueAt([{
      ref: "proj_1",
      config: {
        scheduled_functions: [scheduleConfig({}, invalidFields)],
      },
    }], new Date("2026-06-15T10:30:00Z"));

    expect(due).toEqual([]);
  });

  test("skips a non-UUID schedule instead of dispatching hidden legacy config", () => {
    const due = scheduledFunctionsDueAt([{
      ref: "proj_1",
      config: {
        scheduled_functions: [scheduleConfig({}, { id: "hidden-noncanonical" })],
      },
    }], new Date("2026-06-15T10:30:00Z"));

    expect(due).toEqual([]);
  });
});

describe("scheduled-function invocation boundary", () => {
  test("rejects a non-UUID schedule before project lookup or fetch", async () => {
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return Response.json({});
    }) as typeof fetch;
    const findByRef = spyOn(projectRepository, "findByRef");
    try {
      const result = await scheduledFunctionWorker.triggerOnce(
        "proj_a",
        scheduleConfig({}, { id: "hidden-noncanonical" }),
      );

      expect(result).toEqual({ ok: false, error: "SCHEDULE_CONFIG_INVALID" });
      expect(findByRef).not.toHaveBeenCalled();
      expect(fetchCount).toBe(0);
    } finally {
      findByRef.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    "X-Project-Ref",
    "APIKEY",
    "authorization",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "proxy-authorization",
    "forwarded",
    "x-forwarded-host",
  ])(
    "rejects platform header %s before project lookup or fetch",
    async (headerName) => {
      let fetchCount = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return Response.json({});
      }) as typeof fetch;
      const findByRef = spyOn(projectRepository, "findByRef");
      try {
        const result = await scheduledFunctionWorker.triggerOnce(
          "proj_a",
          scheduleConfig({ [headerName]: "private-platform-sentinel" }),
        );

        expect(result).toEqual({ ok: false, error: "SCHEDULE_HEADERS_INVALID" });
        expect(findByRef).not.toHaveBeenCalled();
        expect(fetchCount).toBe(0);
      } finally {
        findByRef.mockRestore();
        globalThis.fetch = originalFetch;
      }
    },
  );

  test("skips a body over 1 MiB before project lookup or fetch", async () => {
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return Response.json({});
    }) as typeof fetch;
    const findByRef = spyOn(projectRepository, "findByRef");
    try {
      const result = await scheduledFunctionWorker.triggerOnce(
        "proj_a",
        scheduleConfig({}, { body: { payload: "x".repeat(MAX_SCHEDULE_BODY_BYTES) } }),
      );

      expect(result).toEqual({ ok: false, error: "SCHEDULE_CONFIG_INVALID" });
      expect(findByRef).not.toHaveBeenCalled();
      expect(fetchCount).toBe(0);
    } finally {
      findByRef.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps invalid header values out of invocation errors", async () => {
    const secretSentinel = "private-invalid-worker-header-sentinel\n";
    const result = await scheduledFunctionWorker.triggerOnce(
      "proj_a",
      scheduleConfig({ "x-schedule-token": secretSentinel }),
    );

    expect(result).toEqual({ ok: false, error: "SCHEDULE_HEADERS_INVALID" });
    expect(result.error).not.toContain(secretSentinel.trim());
  });

  test("applies platform routing and auth headers after custom headers", async () => {
    const serviceRole = "private-service-role-sentinel";
    const originalFetch = globalThis.fetch;
    let receivedHeaders: Headers | null = null;
    globalThis.fetch = (async (_url, init) => {
      receivedHeaders = new Headers(init?.headers);
      return Response.json({ ok: true });
    }) as typeof fetch;
    const findByRef = spyOn(projectRepository, "findByRef").mockResolvedValue({
      service_role_key: serviceRole,
    } as never);
    try {
      const result = await scheduledFunctionWorker.triggerOnce(
        "proj_a",
        scheduleConfig({ "x-schedule-token": "custom-token" }),
      );

      expect(result).toEqual({ ok: true, status: 200 });
      expect(receivedHeaders?.get("x-project-ref")).toBe("proj_a");
      expect(receivedHeaders?.get("apikey")).toBe(serviceRole);
      expect(receivedHeaders?.get("authorization")).toBe(`Bearer ${serviceRole}`);
      expect(receivedHeaders?.get("x-schedule-token")).toBe("custom-token");
    } finally {
      findByRef.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("redacts underlying fetch errors from invocation results", async () => {
    const errorSentinel = "private-fetch-error-sentinel";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error(errorSentinel);
    }) as typeof fetch;
    const findByRef = spyOn(projectRepository, "findByRef").mockResolvedValue({
      service_role_key: "private-service-role-sentinel",
    } as never);
    try {
      const result = await scheduledFunctionWorker.triggerOnce("proj_a", scheduleConfig({}));

      expect(result).toEqual({ ok: false, error: "SCHEDULE_INVOKE_FAILED" });
      expect(result.error).not.toContain(errorSentinel);
    } finally {
      findByRef.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});
