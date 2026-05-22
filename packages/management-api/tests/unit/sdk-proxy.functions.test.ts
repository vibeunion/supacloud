import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { sdkProxyInternals, sdkProxyRoutes, setSdkProxyFetchForTests } from "../../src/routes/sdk-proxy";
import * as dbModule from "../../src/db";
import { projectService } from "../../src/services/project.service";
import { edgeFunctionService } from "../../src/services/edge-function.service";
import { backgroundTaskService } from "../../src/services/background-task.service";
import { config } from "../../src/config";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../../src/config/background-task-settings";

type FetchCall = {
  url: string;
  init?: RequestInit & { duplex?: "half" };
};

function request(path: string, init?: RequestInit & { duplex?: "half" }) {
  const app = new Elysia().use(sdkProxyRoutes);
  const method = init?.method?.toUpperCase() ?? "GET";
  const hasBody =
    init?.body !== undefined && init?.body !== null && !["GET", "HEAD"].includes(method);

  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      ...(hasBody ? { duplex: "half" as const } : {}),
    }),
  );
}

let serialQueue = Promise.resolve();

async function runSerial<T>(fn: () => Promise<T>): Promise<T> {
  const previous = serialQueue;
  let release!: () => void;
  serialQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function withSdkProxyTestContext(
  run: (context: {
    calls: FetchCall[];
    trackSpy: <T extends { mockRestore: () => void }>(spy: T) => T;
  }) => Promise<void>,
): Promise<void> {
  return runSerial(async () => {
    const calls: FetchCall[] = [];
    const restoredSpies: Array<{ mockRestore: () => void }> = [];

    const resolveKeySpy = spyOn(sdkProxyInternals, "resolveProjectRefFromApiKey").mockImplementation((key: string) => {
      if (!key || key === "anon-from-other-project") return Promise.resolve(null);
      return Promise.resolve("proj_1");
    });
    restoredSpies.push(resolveKeySpy);

    setSdkProxyFetchForTests(((input: string | URL | Request, init?: RequestInit & { duplex?: "half" }) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }));
    }) as typeof fetch);

    try {
      await run({
        calls,
        trackSpy<T extends { mockRestore: () => void }>(spy: T): T {
          restoredSpies.push(spy);
          return spy;
        },
      });
    } finally {
      setSdkProxyFetchForTests();
      while (restoredSpies.length > 0) {
        restoredSpies.pop()?.mockRestore();
      }
    }
  });
}

describe("sdkProxyRoutes functions proxy", () => {
  test("POST /functions/v1 forwards request bodies with duplex=half", async () => {
    await withSdkProxyTestContext(async ({ calls }) => {
      const response = await request("/functions/v1/hello", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-project-ref": "proj_1",
          apikey: "anon",
        },
        body: JSON.stringify({ ping: true }),
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:9000/functions/v1/hello");
      expect(calls[0]?.init?.duplex).toBe("half");
    });
  });

  test("GET /functions/v1/health preserves function path instead of hitting runtime health", async () => {
    await withSdkProxyTestContext(async ({ calls }) => {
      const response = await request("/functions/v1/health", {
        method: "GET",
        headers: {
          "x-project-ref": "proj_1",
          apikey: "anon",
          authorization: "Bearer token",
        },
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:9000/functions/v1/health");
    });
  });

  test("OPTIONS /functions/v1 allows SupaCloud async browser headers", async () => {
    await withSdkProxyTestContext(async ({ calls }) => {
      const response = await request("/functions/v1/aorist-generation/generate/crop", {
        method: "OPTIONS",
        headers: {
          origin: "https://aorist.net",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type, x-supacloud-async",
          "x-project-ref": "proj_1",
          apikey: "anon",
        },
      });

      expect(response.status).toBe(204);
      expect(calls).toHaveLength(1);
      const allowedHeaders = response.headers.get("access-control-allow-headers") || "";
      expect(allowedHeaders).toContain("x-supacloud-async");
      expect(allowedHeaders).toContain("x-supacloud-timeout");
      expect(allowedHeaders).toContain("x-supacloud-retries");
    });
  });

  test("POST /functions/v1 auto-enqueues configured background routes without custom headers", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const getSettingsSpy = trackSpy(spyOn(projectService, "getBackgroundTaskSettings").mockResolvedValue({
        ...DEFAULT_BACKGROUND_TASK_SETTINGS,
      }));
      const getApiKeysSpy = trackSpy(spyOn(projectService, "getApiKeys").mockResolvedValue({
        anon_key: "anon",
        service_role_key: "service",
      } as Awaited<ReturnType<typeof projectService.getApiKeys>>));
      const getConfigSpy = trackSpy(spyOn(edgeFunctionService, "getConfig").mockResolvedValue({
        verify_jwt: false,
        version: "7",
        background_routes: ["/generate/crop"],
      }));
      const enqueueSpy = trackSpy(spyOn(backgroundTaskService, "enqueueBackgroundFunctionTask").mockResolvedValue({
        id: "task_123",
        project_ref: "proj_1",
        task_type: "edge_function",
        function_slug: "aorist-ai",
        function_version: "7",
        status: "pending",
        attempt: 1,
        max_attempts: 3,
      } as Awaited<ReturnType<typeof backgroundTaskService.enqueueBackgroundFunctionTask>>));

      const response = await request("/functions/v1/aorist-ai/generate/crop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-project-ref": "proj_1",
          apikey: "anon",
          authorization: "Bearer jwt-token",
        },
        body: JSON.stringify({ ping: true }),
      });

      expect(response.status).toBe(202);
      expect(response.headers.get("x-supacloud-task-id")).toBe("task_123");
      expect(calls).toHaveLength(0);
      expect(getConfigSpy).toHaveBeenCalledWith("proj_1", "aorist-ai");
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(getSettingsSpy).toHaveBeenCalledWith("proj_1");
      expect(getApiKeysSpy.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  test("POST /functions/v1 uses SupaCloud idempotency header for background route enqueue", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      trackSpy(spyOn(projectService, "getBackgroundTaskSettings").mockResolvedValue({
        ...DEFAULT_BACKGROUND_TASK_SETTINGS,
      }));
      trackSpy(spyOn(projectService, "getApiKeys").mockResolvedValue({
        anon_key: "anon",
        service_role_key: "service",
      } as Awaited<ReturnType<typeof projectService.getApiKeys>>));
      trackSpy(spyOn(edgeFunctionService, "getConfig").mockResolvedValue({
        verify_jwt: false,
        version: "7",
        background_routes: ["/generate/crop"],
      }));
      const enqueueSpy = trackSpy(spyOn(backgroundTaskService, "enqueueBackgroundFunctionTask").mockResolvedValue({
        id: "task_123",
        project_ref: "proj_1",
        task_type: "edge_function",
        function_slug: "aorist-ai",
        function_version: "7",
        status: "pending",
        attempt: 1,
        max_attempts: 3,
      } as Awaited<ReturnType<typeof backgroundTaskService.enqueueBackgroundFunctionTask>>));

      const response = await request("/functions/v1/aorist-ai/generate/crop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-project-ref": "proj_1",
          "x-supacloud-idempotency-key": "aorist:user_1:crop-img_1",
          apikey: "anon",
          authorization: "Bearer jwt-token",
        },
        body: JSON.stringify({ ping: true }),
      });

      expect(response.status).toBe(202);
      expect(calls).toHaveLength(0);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy.mock.calls[0]?.[0]).toMatchObject({
        idempotencyKey: "aorist:user_1:crop-img_1",
      });
    });
  });

  test("auth proxy resolves tenant ports from projects.config", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const sqlSpy = trackSpy(spyOn(dbModule, "sql"));
      sqlSpy.mockImplementation(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("FROM projects")) {
          return [{
            config: {
              postgrest_port: 7361,
              gotrue_port: 8361,
            },
          }];
        }
        return [];
      });

      const response = await request("/auth/v1/health", {
        method: "GET",
        headers: {
          "x-project-ref": "proj_1",
          apikey: "anon",
        },
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8361/health");
    });
  });

  test("auth proxy resolves project ref from forwarded custom API host", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const sqlSpy = trackSpy(spyOn(dbModule, "sql"));
      sqlSpy.mockImplementation(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT ref")) {
          return [{ ref: "proj_1" }];
        }
        if (text.includes("SELECT config")) {
          return [{
            config: {
              postgrest_port: 7361,
              gotrue_port: 8361,
            },
          }];
        }
        return [];
      });

      const response = await request("/auth/v1/health", {
        method: "GET",
        headers: {
          "x-forwarded-host": "api.aorist.net",
          apikey: "anon",
        },
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8361/health");
    });
  });

  test("functions proxy accepts Kong-injected project ref on trusted custom API host without apikey", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const sqlSpy = trackSpy(spyOn(dbModule, "sql"));
      sqlSpy.mockImplementation(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT ref")) {
          return [{ ref: "proj_1" }];
        }
        return [];
      });

      const response = await request("/functions/v1/aorist-platform/me/identity", {
        method: "GET",
        headers: {
          host: "api.aorist.net",
          "x-project-ref": "proj_1",
        },
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:9000/functions/v1/aorist-platform/me/identity");
    });
  });

  test("proxy rejects mismatched project header and apikey", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const sqlSpy = trackSpy(spyOn(dbModule, "sql"));
      sqlSpy.mockImplementation(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("anon_key")) {
          return [{ ref: "proj_from_key" }];
        }
        return [];
      });

      const response = await request("/auth/v1/health", {
        method: "GET",
        headers: {
          "x-project-ref": "proj_from_header",
          apikey: "anon-from-other-project",
        },
      });

      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  test("proxy replaces client supplied forwarding headers", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const sqlSpy = trackSpy(spyOn(dbModule, "sql"));
      sqlSpy.mockImplementation(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT config")) {
          return [{
            config: {
              postgrest_port: 7361,
              gotrue_port: 8361,
            },
          }];
        }
        return [];
      });

      const response = await request("/auth/v1/health", {
        method: "GET",
        headers: {
          "x-project-ref": "proj_1",
          apikey: "anon",
          "x-forwarded-host": "proj_1.localhost",
          "x-forwarded-proto": "http",
          "x-forwarded-for": "203.0.113.10",
          "x-real-ip": "203.0.113.11",
        },
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("x-forwarded-host")).toBe("localhost");
      expect(headers.get("x-forwarded-proto")).toBe("http");
      expect(headers.get("x-forwarded-for")).toBe("127.0.0.1");
      expect(headers.get("x-real-ip")).toBeNull();
    });
  });

  test("rest proxy uses the REST timeout and reports upstream aborts as 504", async () => {
    await withSdkProxyTestContext(async ({ trackSpy }) => {
      const originalRestTimeout = config.restProxyTimeoutMs;
      config.restProxyTimeoutMs = 1;

      const sqlSpy = trackSpy(spyOn(dbModule, "sql"));
      sqlSpy.mockImplementation(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT config")) {
          return [{
            config: {
              postgrest_port: 7361,
              gotrue_port: 8361,
            },
          }];
        }
        return [];
      });

      setSdkProxyFetchForTests(((input: string | URL | Request, init?: RequestInit & { duplex?: "half" }) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }) as typeof fetch);

      try {
        const response = await request("/rest/v1/todos?select=*", {
          method: "GET",
          headers: {
            "x-project-ref": "proj_1",
            apikey: "anon",
          },
        });

        expect(response.status).toBe(504);
        expect(await response.json()).toEqual({ message: "Upstream Proxy Timeout" });
      } finally {
        config.restProxyTimeoutMs = originalRestTimeout;
      }
    });
  });
});
