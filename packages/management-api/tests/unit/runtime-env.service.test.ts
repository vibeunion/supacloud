import { describe, expect, spyOn, test } from "bun:test";
import { runtimeEnvService } from "../../src/services/runtime-env.service";
import { projectRepository } from "../../src/repositories/project.repository";
import { databaseService } from "../../src/services/database.service";
import { config } from "../../src/config";
import { jwtService } from "../../src/services/jwt.service";
import { isStoredServiceRoleKeyAligned } from "../../src/utils/service-role";

describe("runtimeEnvService", () => {
  test("repairs stale HS256 service-role keys before exposing runtime env", async () => {
    const currentSecret = "current-jwt-secret-with-at-least-32-characters";
    const staleKey = await jwtService.generateServiceRoleKey(
      "old-jwt-secret-with-at-least-32-characters",
    );
    let storedProject = {
      id: "proj_id",
      ref: "proj_1",
      name: "Project 1",
      db_name: "supa_proj_1",
      db_user: "role_proj_1",
      db_password: "pw",
      jwt_secret: currentSecret,
      anon_key: "anon.header.signature",
      service_role_key: staleKey,
      s3_bucket: "bucket",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      organization_id: "org_1",
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
      config: {
        auth: {
          oauth_server: {
            jwt_keys: [{ kty: "EC", kid: "kid_1", alg: "ES256", key_ops: ["sign"] }],
            jwt_jwks: { keys: [{ kty: "EC", kid: "kid_1", alg: "ES256" }] },
          },
        },
        api_url: "https://api.example.com",
      },
    } as any;
    const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(async () => storedProject);
    const updateApiKeysSpy = spyOn(projectRepository, "updateApiKeys").mockImplementation(async (_ref, keys) => {
      storedProject = { ...storedProject, ...keys };
      return storedProject;
    });
    const secretsSpy = spyOn(databaseService, "getSecrets").mockResolvedValue([]);

    try {
      const env = await runtimeEnvService.buildProjectRuntimeEnv("proj_1");

      expect(updateApiKeysSpy).toHaveBeenCalledTimes(1);
      expect(env?.JWT_SECRET).toBe(currentSecret);
      expect(env?.JWT_KEYS).toContain("kid_1");
      expect(env?.JWT_KEYS).not.toContain("legacy-hs256");
      expect(env?.JWT_JWKS).toContain("kid_1");
      expect(env?.SUPABASE_SERVICE_ROLE_KEY).toBe(storedProject.service_role_key);
      await expect(isStoredServiceRoleKeyAligned({
        service_role_key: String(env?.SUPABASE_SERVICE_ROLE_KEY || ""),
        jwt_secret: currentSecret,
      })).resolves.toBe(true);
    } finally {
      findByRefSpy.mockRestore();
      updateApiKeysSpy.mockRestore();
      secretsSpy.mockRestore();
    }
  });

  test("uses tenant-local PostgREST port for internal REST URL", async () => {
    const previousRestUrl = process.env.SUPACLOUD_INTERNAL_REST_URL;
    const previousInternalRestUrl = process.env.INTERNAL_REST_URL;
    delete process.env.SUPACLOUD_INTERNAL_REST_URL;
    delete process.env.INTERNAL_REST_URL;

    const findByRefSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
      id: "proj_id",
      ref: "proj_1",
      name: "Project 1",
      db_name: "supa_proj_1",
      db_user: "role_proj_1",
      db_password: "pw",
      jwt_secret: "legacy-secret",
      anon_key: "anon.header.signature",
      service_role_key: "service.header.signature",
      s3_bucket: "bucket",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      organization_id: "org_1",
      config: {
        api_url: "https://api.example.com",
        postgrest_port: 3272,
        gotrue_port: 4272,
      },
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    } as never);
    const secretsSpy = spyOn(databaseService, "getSecrets").mockResolvedValue([]);

    try {
      const env = await runtimeEnvService.buildProjectRuntimeEnv("proj_1");

      expect(env?.SUPACLOUD_INTERNAL_REST_URL).toBe("http://127.0.0.1:3272");
      expect(env?.SUPACLOUD_INTERNAL_POSTGREST_PORT).toBe("3272");
      expect(env?.SUPACLOUD_INTERNAL_GOTRUE_PORT).toBe("4272");
    } finally {
      if (previousRestUrl === undefined) delete process.env.SUPACLOUD_INTERNAL_REST_URL;
      else process.env.SUPACLOUD_INTERNAL_REST_URL = previousRestUrl;
      if (previousInternalRestUrl === undefined) delete process.env.INTERNAL_REST_URL;
      else process.env.INTERNAL_REST_URL = previousInternalRestUrl;
      findByRefSpy.mockRestore();
      secretsSpy.mockRestore();
    }
  });

  test("merges enabled third-party issuer JWKS with the legacy project verifier key", async () => {
    const findByRefSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
      id: "proj_id",
      ref: "proj_1",
      name: "Project 1",
      db_name: "supa_proj_1",
      db_user: "role_proj_1",
      db_password: "pw",
      jwt_secret: "legacy-secret",
      anon_key: "anon.header.signature",
      service_role_key: "service.header.signature",
      s3_bucket: "bucket",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      organization_id: "org_1",
      config: {
        auth: {
          third_party_auth: {
            enabled: true,
            issuer: "https://auth.example.com/auth/v1",
            audience: "authenticated",
            client_id: "business-client",
            jwt_jwks: { keys: [{ kty: "EC", kid: "central-kid", alg: "ES256", crv: "P-256", x: "x", y: "y" }] },
          },
        },
        api_url: "https://api.example.com",
      },
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    } as never);
    const secretsSpy = spyOn(databaseService, "getSecrets").mockResolvedValue([]);

    try {
      const env = await runtimeEnvService.buildProjectRuntimeEnv("proj_1");
      const jwks = JSON.parse(String(env?.JWT_JWKS));
      expect(jwks.keys.map((key: { kid?: string }) => key.kid)).toEqual([
        "central-kid",
        "legacy-hs256",
      ]);
      expect(JSON.parse(String(env?.SUPACLOUD_THIRD_PARTY_JWT_POLICY))).toMatchObject({
        issuer: "https://auth.example.com/auth/v1",
        audience: ["authenticated"],
        clientId: "business-client",
      });
    } finally {
      findByRefSpy.mockRestore();
      secretsSpy.mockRestore();
    }
  });

  test("uses owner public JWKS and GoTrue port without exposing dependent signing secrets", async () => {
    const originalOwnerRef = config.authRuntimeOwnerRef;
    config.authRuntimeOwnerRef = "auth-owner";
    const dependent = {
      id: "dependent-id",
      ref: "proj_1",
      name: "Dependent",
      db_name: "supa_proj_1",
      db_user: "role_proj_1",
      db_password: "pw",
      jwt_secret: "dependent-secret-with-at-least-32-characters",
      anon_key: "anon.header.signature",
      service_role_key: "service.header.signature",
      s3_bucket: "bucket",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      organization_id: "org_1",
      config: {
        postgrest_port: 3272,
        gotrue_port: 4272,
        auth: {
          third_party_auth: {
            enabled: true,
            issuer: "https://business-auth.example.com/auth/v1",
            audience: "business-audience",
            client_id: "business-client",
            jwt_jwks: {
              keys: [{ kty: "EC", kid: "business-user-key", alg: "ES256", crv: "P-256", x: "business-x", y: "business-y" }],
            },
          },
          oauth_server: {
            jwt_keys: [{ kty: "EC", kid: "dependent-private", alg: "ES256", d: "private" }],
          },
        },
      },
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    };
    const owner = {
      ...dependent,
      id: "owner-id",
      ref: "auth-owner",
      name: "Auth Owner",
      jwt_secret: "owner-secret-with-at-least-32-characters",
      config: {
        postgrest_port: 3372,
        gotrue_port: 9372,
        auth: {
          oauth_server: {
            enabled: true,
            signing_alg: "ES256",
            jwt_keys: [{ kty: "EC", kid: "owner-public", alg: "ES256", d: "private", crv: "P-256", x: "x", y: "y" }],
            jwt_jwks: {
              keys: [{ kty: "EC", kid: "owner-public", alg: "ES256", crv: "P-256", x: "x", y: "y" }],
            },
          },
        },
      },
    };
    const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(async (ref: string) =>
      (ref === "auth-owner" ? owner : dependent) as never
    );
    const secretsSpy = spyOn(databaseService, "getSecrets").mockResolvedValue([]);

    try {
      const env = await runtimeEnvService.buildProjectRuntimeEnv("proj_1");
      expect(env?.SUPACLOUD_AUTH_RUNTIME_MODE).toBe("shared");
      expect(env?.SUPACLOUD_AUTH_AUTHORITY_REF).toBe("auth-owner");
      expect(env?.SUPACLOUD_AUTH_ISSUER).toContain("/auth/v1");
      expect(env?.SUPACLOUD_INTERNAL_POSTGREST_PORT).toBe("3272");
      expect(env?.SUPACLOUD_INTERNAL_GOTRUE_PORT).toBe("9372");
      expect(env?.JWT_JWKS).toContain("owner-public");
      expect(env?.JWT_JWKS).toContain("legacy-hs256");
      expect(env?.JWT_JWKS).not.toContain("business-user-key");
      expect(env?.SUPACLOUD_THIRD_PARTY_JWT_POLICY).toBeUndefined();
      expect(env?.JWT_SECRET).toBeUndefined();
      expect(env?.JWT_KEYS).toBeUndefined();
      expect(env?.JWT_JWKS).not.toContain("dependent-private");
    } finally {
      config.authRuntimeOwnerRef = originalOwnerRef;
      findByRefSpy.mockRestore();
      secretsSpy.mockRestore();
    }
  });
});
