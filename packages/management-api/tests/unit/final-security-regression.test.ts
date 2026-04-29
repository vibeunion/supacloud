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
