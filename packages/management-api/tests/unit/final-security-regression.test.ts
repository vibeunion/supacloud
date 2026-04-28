import { describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { projectFunctionsRoutes } from "../../src/routes/project-functions";
import { projectConfigRoutes } from "../../src/routes/project-config";
import { projectService } from "../../src/services/project.service";
import { restoreLogicalBackup } from "../../src/services/backup.service";
import { backgroundTaskService } from "../../src/services/background-task.service";
import { edgeFunctionService } from "../../src/services/edge-function.service";
import { sdkProxyInternals } from "../../src/routes/sdk-proxy";
import { decryptSecretIfNeeded, isEncryptedSecret } from "../../src/utils/secret-crypto";

const masterHeaders = { Authorization: "Bearer dev-master-token" };

function appWith(routes: Elysia) {
  const app = new Elysia().use(routes);
  return (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
}

describe("final security regressions", () => {
  test("function secrets GET requires auth and masks by default", async () => {
    const getSecretsSpy = spyOn(projectService, "getSecrets").mockResolvedValue([
      { name: "EDGEFN_SECRET", value: "plain-secret" },
    ] as Awaited<ReturnType<typeof projectService.getSecrets>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/functions/secrets");
      expect(unauthenticated.status).toBe(401);

      const masked = await request("/v1/projects/proj_1/functions/secrets", { headers: masterHeaders });
      expect(masked.status).toBe(200);
      expect(await masked.json()).toEqual([
        expect.objectContaining({ name: "EDGEFN_SECRET", value: "********" }),
      ]);

      const reveal = await request("/v1/projects/proj_1/functions/secrets?reveal=true", { headers: masterHeaders });
      expect(reveal.status).toBe(200);
      expect(await reveal.json()).toEqual([
        expect.objectContaining({ name: "EDGEFN_SECRET", value: "plain-secret" }),
      ]);
    } finally {
      getSecretsSpy.mockRestore();
    }
  });

  test("per-function secrets GET requires auth and masks by default", async () => {
    const getSecretsSpy = spyOn(projectService, "getSecrets").mockResolvedValue([
      { name: "EDGEFN_HELLO_TOKEN", value: "fn-secret" },
      { name: "EDGEFN_OTHER_TOKEN", value: "other-secret" },
    ] as Awaited<ReturnType<typeof projectService.getSecrets>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/functions/hello/secrets");
      expect(unauthenticated.status).toBe(401);

      const masked = await request("/v1/projects/proj_1/functions/hello/secrets", { headers: masterHeaders });
      expect(masked.status).toBe(200);
      expect(await masked.json()).toEqual([
        expect.objectContaining({ name: "EDGEFN_HELLO_TOKEN", value: "********" }),
      ]);
    } finally {
      getSecretsSpy.mockRestore();
    }
  });

  test("API keys GET requires project or admin auth", async () => {
    const getApiKeysSpy = spyOn(projectService, "getApiKeys").mockResolvedValue({
      anon_key: "anon-key",
      service_role_key: "service-key",
    });
    const request = appWith(projectConfigRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/api-keys");
      expect(unauthenticated.status).toBe(401);

      const authenticated = await request("/v1/projects/proj_1/api-keys", { headers: masterHeaders });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual([
        { name: "anon", api_key: "anon-key" },
        { name: "service_role", api_key: "********" },
      ]);
    } finally {
      getApiKeysSpy.mockRestore();
    }
  });

  test("logical restore rejects path traversal backup ids", async () => {
    const result = await restoreLogicalBackup("proj_1", "../../etc/passwd");
    expect(result.success).toBe(false);
    expect(result.message).toBe("Invalid backup id");
  });

  test("background function tasks persist encrypted credentials", async () => {
    const getConfigSpy = spyOn(edgeFunctionService, "getConfig").mockResolvedValue({
      verify_jwt: false,
      version: "1",
      background_routes: ["/async"],
    });
    const getSettingsSpy = spyOn(projectService, "getBackgroundTaskSettings").mockResolvedValue({
      concurrency: 2,
      max_attempts: 3,
      max_payload_bytes: 262144,
      timeout_sec_default: 300,
      timeout_sec_max: 900,
    });
    const getApiKeysSpy = spyOn(projectService, "getApiKeys").mockResolvedValue({
      anon_key: "anon-key",
      service_role_key: "service-key",
    });
    const enqueueSpy = spyOn(backgroundTaskService, "enqueueBackgroundFunctionTask").mockImplementation(async (input) => ({
      id: "task_1",
      project_ref: input.projectRef,
      task_type: "edge_function",
      function_slug: input.functionSlug,
      function_version: input.functionVersion,
      status: "pending",
      attempt: 1,
      max_attempts: input.maxAttempts,
    }) as Awaited<ReturnType<typeof backgroundTaskService.enqueueBackgroundFunctionTask>>);

    try {
      const response = await sdkProxyInternals.maybeEnqueueAsyncFunction(new Request("http://localhost/functions/v1/hello/async", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: "anon-key",
          authorization: "Bearer user-jwt",
        },
        body: JSON.stringify({ ok: true }),
      }), "proj_1");

      expect(response?.status).toBe(202);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const envelope = enqueueSpy.mock.calls[0]?.[0].envelope;
      expect(envelope.auth.authorization).not.toBe("Bearer user-jwt");
      expect(envelope.auth.apikey).not.toBe("anon-key");
      expect(isEncryptedSecret(envelope.auth.authorization)).toBe(true);
      expect(isEncryptedSecret(envelope.auth.apikey)).toBe(true);
      expect(decryptSecretIfNeeded(envelope.auth.authorization || "")).toBe("Bearer user-jwt");
      expect(decryptSecretIfNeeded(envelope.auth.apikey || "")).toBe("anon-key");
    } finally {
      getConfigSpy.mockRestore();
      getSettingsSpy.mockRestore();
      getApiKeysSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });
});
