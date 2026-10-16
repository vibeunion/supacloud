import { describe, expect, spyOn, test } from "bun:test";
import { runtimeEnvService } from "../../src/services/runtime-env.service";
import { projectRepository } from "../../src/repositories/project.repository";
import { databaseService } from "../../src/services/database.service";
import { config } from "../../src/config";
import { jwtService } from "../../src/services/jwt.service";
import {
  isStoredServiceRoleKeyAligned,
  resolveProjectServiceJwtVerifier,
  resolveProjectServiceRoleKey,
} from "../../src/utils/service-role";
import { generateOidcJwtKeyMaterial } from "../../src/utils/project-jwt";
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { buildFallbackTenantEnv, normalizeTenantEnv } from "../../../edge-runtime/tenant-env";
import { readEdgeRuntimeProjectSecrets, verifyEdgeRuntimeJwt } from "../../../edge-runtime/jwt-verifier";

describe("runtimeEnvService", () => {
  test("repairs stale HS256 service-role keys before exposing runtime env", async () => {
    const currentSecret = "current-jwt-secret-with-at-least-32-characters";
    const staleKey = await jwtService.generateServiceRoleKey(
      "old-jwt-secret-with-at-least-32-characters",
    );
    const keyMaterial = await generateOidcJwtKeyMaterial(currentSecret);
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
            jwt_keys: keyMaterial.jwt_keys,
            jwt_jwks: keyMaterial.jwt_jwks,
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
    const secretsSpy = spyOn(databaseService, "getSecrets").mockResolvedValue([
      { name: "SUPACLOUD_SERVICE_JWT_VERIFIER", value: "untrusted-custom-verifier" },
    ]);

    try {
      const env = await runtimeEnvService.buildProjectRuntimeEnv("proj_1");

      expect(updateApiKeysSpy).toHaveBeenCalledTimes(1);
      const verifier = resolveProjectServiceJwtVerifier("proj_1", storedProject.config);
      expect(env?.SUPACLOUD_SERVICE_JWT_VERIFIER).toBe(JSON.stringify(verifier));
      expect(verifier?.jwks.keys).toHaveLength(1);
      expect(verifier?.jwks.keys[0]).not.toHaveProperty("d");
      expect(verifier?.jwks.keys[0]).not.toHaveProperty("k");
      const serviceToken = await resolveProjectServiceRoleKey(storedProject);
      const publicKey = await importJWK(verifier!.jwks.keys[0]!, "ES256");
      const verified = await jwtVerify(serviceToken!, publicKey, {
        algorithms: ["ES256"], issuer: verifier!.issuer,
        requiredClaims: ["ref", "iat", "exp", "role"],
      });
      expect(verified.payload.ref).toBe("proj_1");
      expect(verified.payload.role).toBe("service_role");
      expect(verified.payload.exp! - verified.payload.iat!).toBe(300);
      for (const mode of ["local", "owner", "shared"]) {
        const edgeSecrets = readEdgeRuntimeProjectSecrets({
          ...env, SUPACLOUD_AUTH_RUNTIME_MODE: mode,
          SUPACLOUD_AUTH_ISSUER: "https://different-owner.example.test/auth/v1",
        })!;
        expect(await verifyEdgeRuntimeJwt(edgeSecrets, `Bearer ${serviceToken}`)).toBe(true);
        expect(await verifyEdgeRuntimeJwt({ ...edgeSecrets, projectRef: "foreign" },
          `Bearer ${serviceToken}`)).toBe(false);
        expect(await verifyEdgeRuntimeJwt({ ...edgeSecrets, serviceVerifier: "{}" },
          `Bearer ${serviceToken}`)).toBe(false);
      }
      await expect(jwtVerify(serviceToken!, publicKey, {
        currentDate: new Date((verified.payload.exp! + 1) * 1000),
      })).rejects.toThrow();
      expect(env?.JWT_SECRET).toBe(currentSecret);
      expect(env?.JWT_KEYS).toContain(keyMaterial.key_id);
      expect(env?.JWT_KEYS).not.toContain("legacy-hs256");
      expect(env?.JWT_JWKS).toContain(keyMaterial.key_id);
      expect(env?.SUPABASE_SERVICE_ROLE_KEY).toBe(storedProject.service_role_key);
      await expect(isStoredServiceRoleKeyAligned({
        service_role_key: String(env?.SUPABASE_SERVICE_ROLE_KEY || ""),
        jwt_secret: currentSecret,
      })).resolves.toBe(true);
      const durableKey = String(env?.SUPABASE_SERVICE_ROLE_KEY);
      expect(decodeProtectedHeader(durableKey).alg).toBe("HS256");
      const payload = decodeJwt(durableKey);
      expect(Number(payload.exp) - Number(payload.iat)).toBeGreaterThan(86400);
      const refreshedEnv = await runtimeEnvService.buildProjectRuntimeEnv("proj_1");
      expect(refreshedEnv?.SUPABASE_SERVICE_ROLE_KEY).toBe(durableKey);
      expect(storedProject.service_role_key).toBe(durableKey);
      expect(updateApiKeysSpy).toHaveBeenCalledTimes(1);
    } finally {
      findByRefSpy.mockRestore();
      updateApiKeysSpy.mockRestore();
      secretsSpy.mockRestore();
    }
  });

  test("service verifier trusts only the actual project signer, never mixed public JWKS", async () => {
    const material = await generateOidcJwtKeyMaterial("project-secret");
    const projectConfig = { auth: { oauth_server: {
      issuer: "https://project.example.test/auth/v1/",
      jwt_keys: material.jwt_keys,
      jwt_jwks: { keys: [{ kty: "EC", kid: "foreign-key", x: "foreign", y: "foreign" }] },
    } } };
    const verifier = resolveProjectServiceJwtVerifier("project", projectConfig);
    expect(verifier?.issuer).toBe("https://project.example.test/auth/v1");
    expect(verifier?.jwks.keys[0]?.kid).toBe(material.key_id);
    for (const jwt_keys of [undefined, "{", [], [{ kty: "oct", k: "secret" }]]) {
      expect(resolveProjectServiceJwtVerifier("project", {
        auth: { oauth_server: { jwt_keys, jwt_jwks: material.jwt_jwks } },
      })).toBeNull();
    }
  });

  test("file fallback never reintroduces service verifier material into shared tenants", () => {
    const value = JSON.stringify({ schema: "untrusted-file-material" });
    const env = { SUPACLOUD_AUTH_RUNTIME_MODE: "shared", SUPACLOUD_SERVICE_JWT_VERIFIER: value };
    expect(normalizeTenantEnv("project", env).SUPACLOUD_SERVICE_JWT_VERIFIER).toBe(value);
    for (const mode of ["local", "owner", "shared"]) {
      const input = { ...env, SUPACLOUD_AUTH_RUNTIME_MODE: mode };
      expect(buildFallbackTenantEnv("project", input).SUPACLOUD_SERVICE_JWT_VERIFIER).toBeUndefined();
      expect(buildFallbackTenantEnv("project", input, input).SUPACLOUD_SERVICE_JWT_VERIFIER).toBeUndefined();
    }
    expect(normalizeTenantEnv("project", {
      SUPACLOUD_SERVICE_JWT_VERIFIER: value,
    }).SUPACLOUD_SERVICE_JWT_VERIFIER).toBeUndefined();
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
    const secretsSpy = spyOn(databaseService, "getSecrets").mockResolvedValue([
      { name: "SUPACLOUD_SERVICE_JWT_VERIFIER", value: "untrusted-custom-verifier" },
    ]);

    try {
      const env = await runtimeEnvService.buildProjectRuntimeEnv("proj_1");
      expect(env?.SUPACLOUD_SERVICE_JWT_VERIFIER).toBe("");

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
