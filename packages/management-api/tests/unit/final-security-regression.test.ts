import { describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { projectFunctionsRoutes } from "../../src/routes/project-functions";
import { projectSecretsRoutes } from "../../src/routes/project-secrets";
import { projectConfigRoutes } from "../../src/routes/project-config";
import { projectService } from "../../src/services/project.service";
import { runtimeEnvService } from "../../src/services/runtime-env.service";
import { restoreLogicalBackup } from "../../src/services/backup.service";
import { sdkProxyInternals } from "../../src/routes/sdk-proxy";
import { decryptSecretIfNeeded, isEncryptedSecret } from "../../src/utils/secret-crypto";

const masterHeaders = { Authorization: "Bearer dev-master-token" };

function appWith(routes: Elysia) {
  const app = new Elysia().use(routes);
  return (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
}

describe("final security regressions", () => {
  test("function management read endpoints require auth but preserve authenticated access", async () => {
    const listFunctionsSpy = spyOn(projectService, "listFunctions").mockResolvedValue([
      { slug: "hello", name: "hello" },
    ] as Awaited<ReturnType<typeof projectService.listFunctions>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const protectedPaths = [
        "/v1/projects/proj_1/functions",
        "/v1/projects/proj_1/functions/hello",
        "/v1/projects/proj_1/functions/hello/source",
        "/v1/projects/proj_1/functions/hello/versions",
        "/v1/projects/proj_1/functions/hello/versions/1",
        "/v1/projects/proj_1/functions/hello/body",
        "/v1/projects/proj_1/functions/hello/check",
        "/v1/projects/proj_1/functions/hello/config",
        "/v1/projects/proj_1/functions/hello/logs",
      ];

      for (const path of protectedPaths) {
        const unauthenticated = await request(path);
        expect(unauthenticated.status).toBe(401);
      }

      expect(listFunctionsSpy).not.toHaveBeenCalled();
      const authenticated = await request("/v1/projects/proj_1/functions", { headers: masterHeaders });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual([{ slug: "hello", name: "hello" }]);
    } finally {
      listFunctionsSpy.mockRestore();
    }
  });

  test("function secrets GET requires auth and never reveals values", async () => {
    const getSecretsSpy = spyOn(projectService, "getSecrets").mockResolvedValue([
      { name: "EDGEFN_SECRET", value: "plain-secret" },
      { name: "SUPACLOUD_INTERNAL_TOKEN", value: "internal-secret" },
      { name: "JWT_SECRET", value: "jwt-secret" },
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
        expect.objectContaining({ name: "EDGEFN_SECRET", value: "********" }),
      ]);
    } finally {
      getSecretsSpy.mockRestore();
    }
  });

  test("project secrets never reveal values outside the internal runtime endpoint", async () => {
    const getSecretsSpy = spyOn(projectService, "getSecrets").mockResolvedValue([
      { name: "CAPTCHA_SECRET", value: "plain-secret" },
      { name: "SUPACLOUD_INTERNAL_TOKEN", value: "internal-secret" },
      { name: "ADMIN_SSO_CLIENT_ID", value: "internal-client" },
      { name: "JWT_SECRET", value: "jwt-secret" },
    ] as Awaited<ReturnType<typeof projectService.getSecrets>>);
    const request = appWith(projectSecretsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/secrets?reveal=true", {
        headers: masterHeaders,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        { name: "CAPTCHA_SECRET", value: "********" },
      ]);
    } finally {
      getSecretsSpy.mockRestore();
    }
  });

  test("project secret writes cannot overwrite or delete system-managed names", async () => {
    const upsertSecretsSpy = spyOn(projectService, "upsertSecrets").mockResolvedValue(true);
    const deleteSecretSpy = spyOn(projectService, "deleteSecret").mockResolvedValue(true);
    const request = appWith(projectSecretsRoutes);

    try {
      const writeResponse = await request("/v1/projects/proj_1/secrets", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify([{ name: "SUPACLOUD_INTERNAL_TOKEN", value: "replacement" }]),
      });
      const bulkDeleteResponse = await request("/v1/projects/proj_1/secrets", {
        method: "DELETE",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(["JWT_SECRET"]),
      });
      const singleDeleteResponse = await request("/v1/projects/proj_1/secrets/JWT_SECRET", {
        method: "DELETE",
        headers: masterHeaders,
      });

      expect(writeResponse.status).toBe(400);
      expect(bulkDeleteResponse.status).toBe(400);
      expect(singleDeleteResponse.status).toBe(400);
      expect(upsertSecretsSpy).not.toHaveBeenCalled();
      expect(deleteSecretSpy).not.toHaveBeenCalled();
    } finally {
      upsertSecretsSpy.mockRestore();
      deleteSecretSpy.mockRestore();
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

  test("function deploy response exposes bundle and preheat metadata", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionDetailed").mockResolvedValue({
      success: true,
      version: "3",
      bundled: true,
      bundle_hash: "0123456789abcdef",
      bundle_size_bytes: 4096,
      import_count: 2,
      external_packages: ["left-pad"],
      preheat: {
        ok: true,
        duration_ms: 15,
        attempted: 3,
        succeeded: 3,
        cache_hits: 1,
        cache_misses: 2,
      },
    } as Awaited<ReturnType<typeof projectService.deployFunctionDetailed>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/hello", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ code: "export default { fetch() { return new Response('ok') } }" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        bundled: true,
        version: "3",
        bundle_hash: "0123456789abcdef",
        bundle_size_bytes: 4096,
        import_count: 2,
        external_packages: ["left-pad"],
        preheat: {
          ok: true,
          attempted: 3,
          succeeded: 3,
          cache_hits: 1,
          cache_misses: 2,
        },
      });
      expect(deploySpy).toHaveBeenCalledWith(
        "proj_1",
        "hello",
        "export default { fetch() { return new Response('ok') } }",
        false,
      );
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("internal runtime env endpoint requires master auth and returns unmasked values", async () => {
    const runtimeEnvSpy = spyOn(runtimeEnvService, "buildProjectRuntimeEnv").mockResolvedValue({
      SUPACLOUD_PROJECT_REF: "proj_1",
      SUPABASE_SERVICE_ROLE_KEY: "header.payload.signature",
    });
    const request = appWith(projectSecretsRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/internal/runtime-env");
      expect(unauthenticated.status).toBe(401);

      const authenticated = await request("/v1/projects/proj_1/internal/runtime-env", { headers: masterHeaders });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual({
        SUPACLOUD_PROJECT_REF: "proj_1",
        SUPABASE_SERVICE_ROLE_KEY: "header.payload.signature",
      });
    } finally {
      runtimeEnvSpy.mockRestore();
    }
  });

  test("project secrets writes invalidate Edge Runtime env cache", async () => {
    const originalFetch = globalThis.fetch;
    const upsertSecretsSpy = spyOn(projectService, "upsertSecrets").mockResolvedValue(true);
    const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/invalidate-env/proj_1");
      expect(init?.method).toBe("POST");
      return Promise.resolve(Response.json({ invalidated: "proj_1" }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const request = appWith(projectSecretsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/secrets", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify([{ name: "RESULT_S3_ENDPOINT", value: "http://new-s3.local" }]),
      });

      expect(response.status).toBe(200);
      expect(upsertSecretsSpy).toHaveBeenCalledWith("proj_1", [
        { name: "RESULT_S3_ENDPOINT", value: "http://new-s3.local" },
      ]);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      upsertSecretsSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("API keys GET requires project or admin auth", async () => {
    const getApiKeysSpy = spyOn(projectService, "getApiKeys").mockResolvedValue({
      anon_key: "anon-key",
      service_role_key: "service-key",
      publishable_key: "sb_publishable_example",
      secret_key: "sb_secret_example",
    });
    const request = appWith(projectConfigRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/api-keys");
      expect(unauthenticated.status).toBe(401);

      const authenticated = await request("/v1/projects/proj_1/api-keys", { headers: masterHeaders });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual([
        { name: "publishable", api_key: "sb_publishable_example" },
        { name: "secret", api_key: "********" },
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
    const auth = sdkProxyInternals.buildEncryptedBackgroundAuth({
      authKind: "jwt",
      authorization: "Bearer user-jwt",
      apikey: "anon-key",
      authPayload: { sub: "user_1", role: "authenticated" },
      apikeyKind: "anon",
    });

    expect(auth.authorization).not.toBe("Bearer user-jwt");
    expect(auth.apikey).not.toBe("anon-key");
    expect(isEncryptedSecret(auth.authorization)).toBe(true);
    expect(isEncryptedSecret(auth.apikey)).toBe(true);
    expect(decryptSecretIfNeeded(auth.authorization || "")).toBe("Bearer user-jwt");
    expect(decryptSecretIfNeeded(auth.apikey || "")).toBe("anon-key");
    expect(auth.invoker_user_id).toBe("user_1");
    expect(auth.invoker_role).toBe("authenticated");
    expect(auth.apikey_kind).toBe("anon");
  });
});
