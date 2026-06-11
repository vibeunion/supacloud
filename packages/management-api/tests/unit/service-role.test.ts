import { describe, expect, test } from "bun:test";
import { resolveProjectServiceRoleKey } from "../../src/utils/service-role";
import { generateOidcJwtKeyMaterial } from "../../src/utils/project-jwt";

describe("service-role utils", () => {
  test("signs an ES256 service_role key from migrated OAuth server material", async () => {
    const keyMaterial = await generateOidcJwtKeyMaterial("legacy-jwt-secret");
    const key = await resolveProjectServiceRoleKey({
      ref: "proj_1",
      service_role_key: "stored-hs256-key",
      jwt_secret: "legacy-jwt-secret",
      config: {
        auth: {
          oauth_server: {
            issuer: "https://auth.example.com/auth/v1",
            jwt_keys: keyMaterial.jwt_keys,
          },
        },
      },
    });

    expect(key).toBeTruthy();
    expect(key).not.toBe("stored-hs256-key");
    const [header, payload] = String(key).split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(keyMaterial.key_id);
    expect(payload.iss).toBe("https://auth.example.com/auth/v1");
    expect(payload.role).toBe("service_role");
  });

  test("prefers the stored canonical service_role_key when no OIDC signing key exists", async () => {
    await expect(
      resolveProjectServiceRoleKey({
        service_role_key: "stored-key",
        jwt_secret: "jwt-secret",
      }),
    ).resolves.toBe("stored-key");
  });

  test("falls back to generating a key from jwt_secret when needed", async () => {
    const key = await resolveProjectServiceRoleKey({
      jwt_secret: "fallback-jwt-secret",
    });

    expect(key).toBeTruthy();
    expect(key).not.toBe("fallback-jwt-secret");
  });

  test("returns null when no project key material exists", async () => {
    await expect(resolveProjectServiceRoleKey({})).resolves.toBeNull();
  });
});
