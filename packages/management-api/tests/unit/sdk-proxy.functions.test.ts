import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import {
  sdkProxyInternals,
  sdkProxyRoutes,
  setAdminUserDeletionDispatcherForTests,
  setSdkProxyFetchForTests,
  setSdkProxySqlForTests,
} from "../../src/routes/sdk-proxy";
import { projectService } from "../../src/services/project.service";
import { edgeFunctionService } from "../../src/services/edge-function.service";
import { backgroundTaskService } from "../../src/services/background-task.service";
import { config } from "../../src/config";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../../src/config/background-task-settings";
import { projectAuthInternals } from "../../src/utils/project-auth";

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
      setSdkProxySqlForTests();
      setAdminUserDeletionDispatcherForTests();
      while (restoredSpies.length > 0) {
        restoredSpies.pop()?.mockRestore();
      }
    }
  });
}

describe("sdkProxyRoutes functions proxy", () => {
  test("exposes tenant-bound API key header translation through the internal test seam", () => {
    expect(typeof sdkProxyInternals.translateOpaqueApiKeyHeaders).toBe("function");
    expect(typeof sdkProxyInternals.resolveProjectServiceRoleKey).toBe("function");
    expect(sdkProxyInternals.dispatchAdminUserDeletionThroughManagement.toString())
      .toContain("userManagementRoutes.handle");
  });

  test("merges the soft-delete query into an object body without overriding an explicit body value", async () => {
    const bodyFromQuery = await sdkProxyInternals.adminUserDeletionBody(new Request(
      "http://localhost/auth/v1/admin/users/00000000-0000-4000-8000-000000000001?should_soft_delete=true",
      { method: "DELETE", body: "{}" },
    ));
    const explicitFalse = await sdkProxyInternals.adminUserDeletionBody(new Request(
      "http://localhost/auth/v1/admin/users/00000000-0000-4000-8000-000000000001?should_soft_delete=true",
      { method: "DELETE", body: JSON.stringify({ should_soft_delete: false }) },
    ));

    expect(JSON.parse(bodyFromQuery)).toEqual({ should_soft_delete: true });
    expect(JSON.parse(explicitFalse)).toEqual({ should_soft_delete: false });
  });

  test("rejects malformed and non-object admin deletion bodies", async () => {
    await expect(sdkProxyInternals.adminUserDeletionBody(new Request(
      "http://localhost/auth/v1/admin/users/00000000-0000-4000-8000-000000000001",
      { method: "DELETE", body: "{" },
    ))).rejects.toThrow("must be valid JSON");
    await expect(sdkProxyInternals.adminUserDeletionBody(new Request(
      "http://localhost/auth/v1/admin/users/00000000-0000-4000-8000-000000000001",
      { method: "DELETE", body: "[]" },
    ))).rejects.toThrow("must be a JSON object");
  });

  test("resolves an opaque Secret Key through its hash without storing plaintext", async () => {
    const lookup = projectAuthInternals.buildApiKeyLookup("sb_secret_server_key", {
      includeProvisioning: true,
    });
    const resolved = projectAuthInternals.resolveApiKeyRow(
      "sb_secret_server_key",
      lookup.secretHash,
      {
        ref: "proj_1",
        anon_key: "legacy-anon-jwt",
        service_role_key: "legacy-service-jwt",
        publishable_key: "sb_publishable_client_key",
        secret_key_hash: "2d1de1eeb6dac1bf5040d556aa9412c70d9079294c6e35b2b760663de526fe7f",
      },
    );

    expect(resolved).toEqual({
      ref: "proj_1",
      kind: "secret",
      role: "service_role",
      upstreamKey: "legacy-service-jwt",
    });
    expect(lookup.params[0]).toBe("sb_secret_server_key");
    expect(lookup.params[1]).not.toContain("sb_secret_server_key");
    expect(lookup.params[1]).toHaveLength(64);
  });

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

  test("OPTIONS /functions/v1 stops at the SDK proxy without emitting CORS headers", async () => {
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
      expect(calls).toHaveLength(0);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(response.headers.has("access-control-allow-headers")).toBe(false);
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
      setSdkProxySqlForTests(async (...args: unknown[]) => {
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
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("host")).toBe(`proj_1.api.${config.baseDomain}`);
      expect(headers.get("x-forwarded-host")).toBe(`proj_1.api.${config.baseDomain}`);
      expect(headers.get("x-project-ref")).toBe("proj_1");
      expect(sdkProxyInternals.resolveProjectRefFromApiKey).toHaveBeenCalledWith("anon", { includeProvisioning: true });
    });
  });

  test("intercepts the exact public admin-user DELETE through the shared deletion orchestrator", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const deletionCalls: Array<Record<string, unknown>> = [];
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "secret",
          role: "service_role",
          upstreamKey: "legacy-service-role-key",
        }),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT config")) {
          return [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }];
        }
        return [];
      });
      setAdminUserDeletionDispatcherForTests(async (input) => {
        deletionCalls.push(input);
        return Response.json({ id: input.userId, deletion_status: "deleted" });
      });

      const userId = "00000000-0000-4000-8000-000000000001";
      const response = await request(`/auth/v1/admin/users/${userId}/`, {
        method: "DELETE",
        headers: {
          apikey: "sb_secret_server_key",
          authorization: "Bearer sb_secret_server_key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ should_soft_delete: true }),
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(0);
      expect(deletionCalls).toHaveLength(1);
      expect(deletionCalls[0]).toMatchObject({
        authorityProjectRef: "proj_1",
        userId,
        directGoTrueUrl: "http://127.0.0.1:8361",
      });
    });
  });

  test("normalizes an encoded UUID before exact admin-user deletion dispatch", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const deletionUserIds: string[] = [];
      trackSpy(spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
        ref: "proj_1",
        kind: "service_role",
        role: "service_role",
        upstreamKey: "legacy-service-role-key",
      }));
      setSdkProxySqlForTests(async (...args: unknown[]) => String(args[0] ?? "").includes("SELECT config")
        ? [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }]
        : []);
      setAdminUserDeletionDispatcherForTests(async (input) => {
        deletionUserIds.push(input.userId);
        return Response.json({ id: input.userId });
      });

      const response = await request(
        "/auth/v1/admin/users/00000000%2D0000%2D4000%2D8000%2D000000000001",
        {
          method: "DELETE",
          headers: { apikey: "legacy-service-role-key" },
        },
      );

      expect(response.status).toBe(200);
      expect(deletionUserIds).toEqual(["00000000-0000-4000-8000-000000000001"]);
      expect(calls).toHaveLength(0);
    });
  });

  test("fails closed for exact admin-user DELETE on a dependent shared-auth project", async () => {
    const originalOwnerRef = config.authRuntimeOwnerRef;
    config.authRuntimeOwnerRef = "auth-owner";
    try {
      await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
        const serviceRoleSigner = trackSpy(
          spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue("owner-service-jwt"),
        );
        trackSpy(
          spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
            ref: "proj_1",
            kind: "secret",
            role: "service_role",
            upstreamKey: "dependent-service-role-key",
          }),
        );
        setSdkProxySqlForTests(async (...args: unknown[]) => {
          const text = String(args[0] ?? "");
          if (text.includes("SELECT config")) {
            return [{ config: { postgrest_port: 7361, gotrue_port: 9361 } }];
          }
          return [];
        });

        const response = await request(
          "/auth/v1/admin/users/00000000-0000-4000-8000-000000000001",
          {
            method: "DELETE",
            headers: {
              apikey: "sb_secret_dependent_key",
              authorization: "Bearer sb_secret_dependent_key",
            },
          },
        );

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          message: "Admin user deletion must use the auth authority project",
        });
        expect(calls).toHaveLength(0);
        expect(serviceRoleSigner).not.toHaveBeenCalled();
      });
    } finally {
      config.authRuntimeOwnerRef = originalOwnerRef;
    }
  });

  test("shared auth proxy uses the owner GoTrue port, key, and project header", async () => {
    const originalOwnerRef = config.authRuntimeOwnerRef;
    const originalGetApiKeys = projectService.getApiKeys;
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.getApiKeys = async (ref: string) => ref === "auth-owner"
      ? {
        anon_key: "owner-anon-jwt",
        service_role_key: "owner-service-jwt",
        publishable_key: "owner-publishable",
        secret_key: "owner-secret",
      }
      : null;

    try {
      await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
        trackSpy(
          spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
            ref: "proj_1",
            kind: "publishable",
            role: "anon",
            upstreamKey: "dependent-anon-jwt",
          }),
        );
        setSdkProxySqlForTests(async (...args: unknown[]) => {
          const text = String(args[0] ?? "");
          if (text.includes("SELECT config")) return [{ config: { gotrue_port: 9361, postgrest_port: 7361 } }];
          return [];
        });

        const response = await request("/auth/v1/health", {
          headers: {
            apikey: "sb_publishable_client_key",
            authorization: "Bearer sb_publishable_client_key",
          },
        });

        expect(response.status).toBe(200);
        expect(calls[0]?.url).toBe("http://127.0.0.1:9361/health");
        const headers = new Headers(calls[0]?.init?.headers);
        expect(headers.get("apikey")).toBe("owner-anon-jwt");
        expect(headers.get("authorization")).toBe("Bearer owner-anon-jwt");
        expect(headers.get("x-project-ref")).toBe("auth-owner");
        expect(headers.get("host")).toBe(`proj_1.api.${config.baseDomain}`);
      });
    } finally {
      config.authRuntimeOwnerRef = originalOwnerRef;
      projectService.getApiKeys = originalGetApiKeys;
    }
  });

  test("shared auth proxy rejects dependent service-role credentials before upstream", async () => {
    const originalOwnerRef = config.authRuntimeOwnerRef;
    const originalGetApiKeys = projectService.getApiKeys;
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.getApiKeys = async () => ({
      anon_key: "owner-anon-jwt",
      service_role_key: "owner-service-jwt",
    } as Awaited<ReturnType<typeof projectService.getApiKeys>>);

    try {
      await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
        const serviceRoleSigner = trackSpy(
          spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue("owner-service-jwt"),
        );
        trackSpy(
          spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
            ref: "proj_1",
            kind: "secret",
            role: "service_role",
            upstreamKey: "dependent-service-jwt",
          }),
        );
        setSdkProxySqlForTests(async (...args: unknown[]) => {
          const text = String(args[0] ?? "");
          if (text.includes("SELECT config")) return [{ config: { gotrue_port: 9361, postgrest_port: 7361 } }];
          return [];
        });

        const response = await request("/auth/v1/admin/users", {
          headers: {
            apikey: "sb_secret_client_key",
            authorization: "Bearer sb_secret_client_key",
          },
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ message: "Invalid API key" });
        expect(calls).toHaveLength(0);
        expect(serviceRoleSigner).not.toHaveBeenCalled();
      });
    } finally {
      config.authRuntimeOwnerRef = originalOwnerRef;
      projectService.getApiKeys = originalGetApiKeys;
    }
  });

  test("shared auth proxy rejects a dependent legacy service-role bearer paired with an anon apikey", async () => {
    const originalOwnerRef = config.authRuntimeOwnerRef;
    const originalGetApiKeys = projectService.getApiKeys;
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.getApiKeys = async (ref: string) => ref === "auth-owner"
      ? {
        anon_key: "owner-anon-jwt",
        service_role_key: "owner-service-jwt",
        publishable_key: "owner-publishable",
        secret_key: "owner-secret",
      }
      : null;

    try {
      await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
        trackSpy(
          spyOn(sdkProxyInternals, "resolveProjectApiKey").mockImplementation(async (candidate: string) => {
            if (candidate === "sb_publishable_client_key") {
              return {
                ref: "proj_1",
                kind: "publishable",
                role: "anon",
                upstreamKey: "dependent-anon-jwt",
              };
            }
            if (candidate === "dependent-service-jwt") {
              return {
                ref: "proj_1",
                kind: "service_role",
                role: "service_role",
                upstreamKey: "dependent-service-jwt",
              };
            }
            return null;
          }),
        );
        setSdkProxySqlForTests(async (...args: unknown[]) => {
          const text = String(args[0] ?? "");
          if (text.includes("SELECT config")) return [{ config: { gotrue_port: 9361, postgrest_port: 7361 } }];
          return [];
        });

        const response = await request("/auth/v1/admin/users", {
          headers: {
            apikey: "sb_publishable_client_key",
            authorization: "Bearer dependent-service-jwt",
          },
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ message: "Invalid API key" });
        expect(calls).toHaveLength(0);
      });
    } finally {
      config.authRuntimeOwnerRef = originalOwnerRef;
      projectService.getApiKeys = originalGetApiKeys;
    }
  });

  test("REST proxy translates a publishable key to the legacy anon JWT", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "publishable",
          role: "anon",
          upstreamKey: "legacy-anon-jwt",
        }),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT config")) {
          return [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }];
        }
        return [];
      });

      const response = await request("/rest/v1/widgets", {
        headers: {
          apikey: "sb_publishable_client_key",
          authorization: "Bearer sb_publishable_client_key",
        },
      });

      expect(response.status).toBe(200);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("apikey")).toBe("legacy-anon-jwt");
      expect(headers.get("authorization")).toBe("Bearer legacy-anon-jwt");
    });
  });

  test("REST proxy signs one project service-role token for an apikey-only opaque request", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      const serviceRoleSigner = trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue("short-lived-es256-jwt"),
      );
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "secret",
          role: "service_role",
          upstreamKey: "legacy-service-jwt",
        }),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT config")) {
          return [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }];
        }
        return [];
      });

      const response = await request("/rest/v1/widgets", {
        headers: { apikey: "sb_secret_client_key" },
      });

      expect(response.status).toBe(200);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("apikey")).toBe("short-lived-es256-jwt");
      expect(headers.get("authorization")).toBe("Bearer short-lived-es256-jwt");
      expect(serviceRoleSigner).toHaveBeenCalledTimes(1);
      expect(serviceRoleSigner).toHaveBeenCalledWith("proj_1");
    });
  });

  test("reuses one signed service-role token for opaque apikey and bearer headers", async () => {
    await withSdkProxyTestContext(async ({ trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "secret",
          role: "service_role",
          upstreamKey: "legacy-service-jwt",
        }),
      );
      const serviceRoleSigner = trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue("short-lived-es256-jwt"),
      );
      const headers = new Headers({
        apikey: "sb_secret_client_key",
        authorization: "Bearer sb_secret_client_key",
      });

      expect(await sdkProxyInternals.translateOpaqueApiKeyHeaders(headers, "proj_1")).toBe(true);
      expect(headers.get("apikey")).toBe("short-lived-es256-jwt");
      expect(headers.get("authorization")).toBe("Bearer short-lived-es256-jwt");
      expect(serviceRoleSigner).toHaveBeenCalledTimes(1);
    });
  });

  test("keeps a user bearer while signing an opaque service-role apikey", async () => {
    await withSdkProxyTestContext(async ({ trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "secret",
          role: "service_role",
          upstreamKey: "legacy-service-jwt",
        }),
      );
      const serviceRoleSigner = trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue("short-lived-es256-jwt"),
      );
      const headers = new Headers({
        apikey: "sb_secret_client_key",
        authorization: "Bearer user.session.jwt",
      });

      expect(await sdkProxyInternals.translateOpaqueApiKeyHeaders(headers, "proj_1")).toBe(true);
      expect(headers.get("apikey")).toBe("short-lived-es256-jwt");
      expect(headers.get("authorization")).toBe("Bearer user.session.jwt");
      expect(serviceRoleSigner).toHaveBeenCalledTimes(1);
    });
  });

  test("re-signs a paired same-project legacy service-role credential", async () => {
    await withSdkProxyTestContext(async ({ trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "service_role",
          role: "service_role",
          upstreamKey: "legacy-service-jwt",
        }),
      );
      const serviceRoleSigner = trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue("short-lived-es256-jwt"),
      );
      const headers = new Headers({
        apikey: "legacy-service-jwt",
        authorization: "Bearer legacy-service-jwt",
      });

      expect(await sdkProxyInternals.translateOpaqueApiKeyHeaders(headers, "proj_1")).toBe(true);
      expect(headers.get("apikey")).toBe("short-lived-es256-jwt");
      expect(headers.get("authorization")).toBe("Bearer short-lived-es256-jwt");
      expect(serviceRoleSigner).toHaveBeenCalledTimes(1);
    });
  });

  test("rejects another project's service-role key before signing or proxying", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_2",
          kind: "secret",
          role: "service_role",
          upstreamKey: "project-2-service-jwt",
        }),
      );
      const serviceRoleSigner = trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue("must-not-be-used"),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => String(args[0] ?? "").includes("SELECT config")
        ? [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }]
        : []);

      const response = await request("/rest/v1/widgets", {
        headers: { apikey: "sb_secret_project_2_key" },
      });

      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
      expect(serviceRoleSigner).not.toHaveBeenCalled();
    });
  });

  test("rejects a service-role key when project signing material is unavailable", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "secret",
          role: "service_role",
          upstreamKey: "legacy-service-jwt",
        }),
      );
      const serviceRoleSigner = trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue(null),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => String(args[0] ?? "").includes("SELECT config")
        ? [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }]
        : []);

      const response = await request("/rest/v1/widgets", {
        headers: { apikey: "sb_secret_client_key" },
      });

      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
      expect(serviceRoleSigner).toHaveBeenCalledTimes(1);
    });
  });

  test("REST proxy preserves a user JWT while translating the publishable apikey", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "publishable",
          role: "anon",
          upstreamKey: "legacy-anon-jwt",
        }),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT config")) {
          return [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }];
        }
        return [];
      });

      const response = await request("/rest/v1/widgets", {
        headers: {
          apikey: "sb_publishable_client_key",
          authorization: "Bearer user.session.jwt",
        },
      });

      expect(response.status).toBe(200);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("apikey")).toBe("legacy-anon-jwt");
      expect(headers.get("authorization")).toBe("Bearer user.session.jwt");
    });
  });

  test("GraphQL proxy translates an opaque key and preserves the user JWT", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "publishable",
          role: "anon",
          upstreamKey: "legacy-anon-jwt",
        }),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT config")) {
          return [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }];
        }
        return [];
      });

      const response = await request("/graphql/v1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: "sb_publishable_client_key",
          authorization: "Bearer user.session.jwt",
        },
        body: JSON.stringify({ query: "query { __typename }" }),
      });

      expect(response.status).toBe(200);
      expect(calls[0]?.url).toBe("http://127.0.0.1:7361/rpc/graphql");
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("apikey")).toBe("legacy-anon-jwt");
      expect(headers.get("authorization")).toBe("Bearer user.session.jwt");
      expect(headers.get("accept-profile")).toBe("graphql_public");
    });
  });

  test("auth proxy resolves project ref from forwarded custom API host", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      setSdkProxySqlForTests(async (...args: unknown[]) => {
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

  test("REST proxy accepts an opaque key on a configured API alias inside the platform base domain", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
          ref: "proj_1",
          kind: "publishable",
          role: "anon",
          upstreamKey: "legacy-anon-jwt",
        }),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT ref, config")) {
          return [{
            ref: "proj_1",
            config: {
              api_domain: `sapi.${config.baseDomain}`,
              postgrest_port: 7361,
              gotrue_port: 8361,
            },
          }];
        }
        if (text.includes("SELECT config")) {
          return [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }];
        }
        return [];
      });

      const response = await request("/rest/v1/widgets", {
        headers: {
          "x-forwarded-host": `sapi.${config.baseDomain}`,
          "x-project-ref": "proj_1",
          apikey: "sb_publishable_client_key",
        },
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("apikey")).toBe("legacy-anon-jwt");
    });
  });

  test("REST proxy rejects another project's opaque key on a configured API alias", async () => {
    await withSdkProxyTestContext(async ({ calls }) => {
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT ref, config")) {
          return [{
            ref: "proj_2",
            config: { api_domain: `sapi.${config.baseDomain}` },
          }];
        }
        return [];
      });

      const response = await request("/rest/v1/widgets", {
        headers: {
          "x-forwarded-host": `sapi.${config.baseDomain}`,
          "x-project-ref": "proj_2",
          apikey: "sb_publishable_project_1_key",
        },
      });

      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  test("auth proxy accepts gateway-injected project ref on loopback without apikey", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT ref")) {
          expect(text).not.toContain("ANY(");
          return [{ ref: "proj_from_header", config: {} }];
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
          host: "127.0.0.1:9090",
          "x-project-ref": "proj_from_header",
        },
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8361/health");
    });
  });

  test("auth proxy accepts gateway-injected project ref from loopback request URL when apikey lookup misses", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      trackSpy(
        spyOn(sdkProxyInternals, "resolveProjectRefFromApiKey").mockResolvedValueOnce(null),
      );
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT ref")) {
          return [{ ref: "proj_from_header", config: {} }];
        }
        if (text.includes("SELECT config")) {
          return [{ config: { gotrue_port: 8361, postgrest_port: 7361 } }];
        }
        return [];
      });

      const response = await request("/auth/v1/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: "unindexed-bootstrap-anon-key",
          authorization: "Bearer unindexed-bootstrap-anon-key",
          "x-project-ref": "proj_from_header",
        },
        body: JSON.stringify({ email: "invalid", password: "1" }),
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8361/signup");
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("host")).toBe(`proj_from_header.api.${config.baseDomain}`);
      expect(headers.get("x-forwarded-host")).toBe(`proj_from_header.api.${config.baseDomain}`);
      expect(headers.get("x-project-ref")).toBe("proj_from_header");
    });
  });

  test("functions proxy accepts gateway-injected project ref on trusted custom API host without apikey", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      let sawProjectLookup = false;
      setSdkProxySqlForTests(async (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (text.includes("SELECT ref")) {
          sawProjectLookup = true;
          expect(text).not.toContain("config->>");
          return [{
            ref: "proj_1",
            config: '{"custom_domain":"api.aorist.net"}',
          }];
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
      expect(sawProjectLookup).toBe(true);
    });
  });

  test("proxy rejects mismatched project header and apikey", async () => {
    await withSdkProxyTestContext(async ({ calls, trackSpy }) => {
      setSdkProxySqlForTests(async (...args: unknown[]) => {
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
      setSdkProxySqlForTests(async (...args: unknown[]) => {
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
      expect(headers.get("host")).toBe(`proj_1.api.${config.baseDomain}`);
      expect(headers.get("x-forwarded-host")).toBe(`proj_1.api.${config.baseDomain}`);
      expect(headers.get("x-forwarded-proto")).toBe("http");
      expect(headers.get("x-forwarded-for")).toBe("127.0.0.1");
      expect(headers.get("x-real-ip")).toBeNull();
    });
  });

  test("rest proxy uses the REST timeout and reports upstream aborts as 504", async () => {
    await withSdkProxyTestContext(async ({ trackSpy }) => {
      const originalRestTimeout = config.restProxyTimeoutMs;
      config.restProxyTimeoutMs = 1;

      setSdkProxySqlForTests(async (...args: unknown[]) => {
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
