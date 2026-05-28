import { describe, expect, spyOn, test } from "bun:test";
import { runtimeEnvService } from "../../src/services/runtime-env.service";
import { projectRepository } from "../../src/repositories/project.repository";
import { databaseService } from "../../src/services/database.service";

describe("runtimeEnvService", () => {
  test("includes project JWKS for Bun Edge Runtime JWT verification", async () => {
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
          oauth_server: {
            jwt_keys: [
              { kty: "EC", kid: "kid_1", alg: "ES256", key_ops: ["sign"] },
              { kty: "oct", kid: "legacy-hs256", alg: "HS256" },
            ],
            jwt_jwks: { keys: [{ kty: "EC", kid: "kid_1", alg: "ES256" }] },
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

      expect(env?.JWT_SECRET).toBe("legacy-secret");
      expect(env?.JWT_KEYS).toContain("kid_1");
      expect(env?.JWT_KEYS).toContain("legacy-hs256");
      expect(env?.JWT_JWKS).toContain("kid_1");
      expect(env?.SUPABASE_SERVICE_ROLE_KEY).toBe("service.header.signature");
    } finally {
      findByRefSpy.mockRestore();
      secretsSpy.mockRestore();
    }
  });
});
