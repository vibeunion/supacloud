import { describe, expect, test } from "bun:test";
import { migrateOAuthServerWithReadback } from "./oauth-server-migration";

function oauthResponse(status: number, payload: Record<string, unknown>) {
  return {
    response: new Response(JSON.stringify(payload), { status }),
    payload,
  };
}

function enabledStatus(): Record<string, unknown> {
  return {
    enabled: true,
    allow_dynamic_registration: false,
    issuer: "https://auth.example.test",
    discovery_url: "https://auth.example.test/.well-known/openid-configuration",
    oauth_authorization_server_metadata_url: "https://auth.example.test/.well-known/oauth-authorization-server",
    jwks_url: "https://auth.example.test/.well-known/jwks.json",
    authorization_endpoint: "https://auth.example.test/authorize",
    token_endpoint: "https://auth.example.test/token",
    registration_endpoint: "https://auth.example.test/register",
    signing_alg: "ES256",
    oidc_id_token_ready: true,
    migration_status: "oidc_es256_migrated",
  };
}

describe("migrateOAuthServerWithReadback", () => {
  test("keeps an ordinary 503 as a migration failure without a readback", async () => {
    let migrationCalls = 0;
    let readbackCalls = 0;

    const migration = migrateOAuthServerWithReadback(
      async () => {
        migrationCalls += 1;
        return oauthResponse(503, { code: "AUTH_RUNTIME_APPLY_FAILED", message: "runtime apply failed" });
      },
      async () => {
        readbackCalls += 1;
        return oauthResponse(200, { enabled: true });
      },
    );

    await expect(migration).rejects.toThrow("runtime apply failed");
    expect(migrationCalls).toBe(1);
    expect(readbackCalls).toBe(0);
  });

  test("accepts an applied partial response only after one enabled readback", async () => {
    let migrationCalls = 0;
    let readbackCalls = 0;

    const status = await migrateOAuthServerWithReadback(
      async () => {
        migrationCalls += 1;
        return oauthResponse(503, {
          code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
          persisted: true,
          runtime_applied: true,
        });
      },
      async () => {
        readbackCalls += 1;
        return oauthResponse(200, enabledStatus());
      },
    );

    expect(status.enabled).toBe(true);
    expect(migrationCalls).toBe(1);
    expect(readbackCalls).toBe(1);
  });

  test("rejects an applied partial response when readback is not enabled", async () => {
    const migration = migrateOAuthServerWithReadback(
      async () => oauthResponse(503, {
        code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
        persisted: true,
        runtime_applied: true,
      }),
      async () => oauthResponse(200, { enabled: false }),
    );

    await expect(migration).rejects.toThrow("状态回读显示 OAuth Server 未启用");
  });

  test("does not swallow a migration network error", async () => {
    let readbackCalls = 0;
    const migration = migrateOAuthServerWithReadback(
      async () => {
        throw new TypeError("migration network unavailable");
      },
      async () => {
        readbackCalls += 1;
        return oauthResponse(200, { enabled: true });
      },
    );

    await expect(migration).rejects.toThrow("migration network unavailable");
    expect(readbackCalls).toBe(0);
  });

  test("does not swallow a readback network error after an applied partial response", async () => {
    const migration = migrateOAuthServerWithReadback(
      async () => oauthResponse(503, {
        code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
        persisted: true,
        runtime_applied: true,
      }),
      async () => {
        throw new TypeError("readback network unavailable");
      },
    );

    await expect(migration).rejects.toThrow("readback network unavailable");
  });
});
