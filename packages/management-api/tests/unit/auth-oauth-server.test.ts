import { describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authOAuthServerRoutes } from "../../src/routes/auth-oauth-server";
import { projectService } from "../../src/services";
import * as dbModule from "../../src/db";
import { tenantRuntimeService } from "../../src/services/tenant-runtime.service";
import { generateOidcJwtKeyMaterial } from "../../src/utils/project-jwt";

const migratedJwtKeys = [{
  kty: "EC",
  crv: "P-256",
  kid: "kid_1",
  alg: "ES256",
  use: "sig",
  x: "abc",
  y: "def",
  d: "def",
}];

const migratedJwtJwks = {
  keys: [{
    kty: "EC",
    crv: "P-256",
    kid: "kid_1",
    alg: "ES256",
    use: "sig",
    x: "abc",
    y: "def",
  }],
};

function request(path: string, init?: RequestInit) {
  const app = new Elysia().use(authOAuthServerRoutes);
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
    }),
  );
}

describe("authOAuthServerRoutes", () => {
  test("GET /oauth-server returns an account-isolated status payload", async () => {
    const projectSpy = spyOn(projectService, "getProject").mockResolvedValue({
      id: "proj_id",
      ref: "proj_1",
      organization_id: "org_1",
      name: "Project 1",
      db_name: "supa_proj_1",
      db_user: "role_proj_1",
      db_password: "pw",
      jwt_secret: "jwt",
      anon_key: "anon",
      service_role_key: "service",
      s3_bucket: "bucket",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      config: {
        auth: {
          oauth_server: {
            enabled: true,
            allow_dynamic_registration: true,
          },
        },
        api_url: "api.example.com",
      },
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    } as never);

    const sqlSpy = spyOn(dbModule, "sql");
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("SELECT service_role_key, jwt_secret")) {
        return [{
          service_role_key: "service",
          jwt_secret: "jwt",
        }];
      }
      if (text.includes("SELECT config, organization_id")) {
        return [{
          config: {
            auth: {
              oauth_server: {
                enabled: true,
                allow_dynamic_registration: true,
                issuer: "https://api.example.com/auth/v1",
                signing_alg: "ES256",
                key_id: "kid_1",
                jwt_keys: migratedJwtKeys,
                jwt_jwks: migratedJwtJwks,
              },
            },
            postgrest_port: 3100,
            gotrue_port: 3200,
          },
          organization_id: "org_1",
          jwt_secret: "jwt",
        }];
      }
      return [];
    });

    const response = await request("/v1/projects/proj_1/auth/oauth-server", {
      headers: { Authorization: "Bearer dev-master-token" },
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.account_isolated).toBe(true);
    expect(payload.organization_id).toBe("org_1");
    expect(payload.enabled).toBe(true);
    expect(payload.signing_alg).toBe("ES256");
    expect(payload.oidc_id_token_ready).toBe(true);
    expect(payload.authorization_endpoint).toBe("https://api.example.com/auth/v1/oauth/authorize");
    expect(payload.registration_endpoint).toBe("https://api.example.com/auth/v1/oauth/clients/register");

    projectSpy.mockRestore();
    sqlSpy.mockRestore();
  });

  test("POST /oauth-server/migrate stores scoped ES256 config and restarts runtime", async () => {
    const projectSpy = spyOn(projectService, "getProject").mockResolvedValue({
      id: "proj_id",
      ref: "proj_1",
      organization_id: "org_1",
      name: "Project 1",
      db_name: "supa_proj_1",
      db_user: "role_proj_1",
      db_password: "pw",
      jwt_secret: "jwt",
      anon_key: "anon",
      service_role_key: "service",
      s3_bucket: "bucket",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      config: {
        auth: {},
      },
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    } as never);
    const settingsSpy = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      auth: {},
    } as never);
    const updateSpy = spyOn(projectService, "updateProjectSettings").mockResolvedValue({
      auth: {
        oauth_server: {
          enabled: true,
          allow_dynamic_registration: true,
        },
      },
    } as never);
    const restartSpy = spyOn(tenantRuntimeService, "restartRuntime").mockResolvedValue(undefined);
    const sqlSpy = spyOn(dbModule, "sql");
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("SELECT config, organization_id")) {
        return [{
          config: {
            auth: {},
            postgrest_port: 3100,
            gotrue_port: 3200,
          },
          organization_id: "org_1",
          jwt_secret: "jwt",
        }];
      }
      return [];
    });

    const response = await request("/v1/projects/proj_1/auth/oauth-server/migrate", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-master-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ allow_dynamic_registration: true }),
    });

    const payload = await response.json();
    const updatePayload = updateSpy.mock.calls[0]?.[1] as { auth?: { oauth_server?: Record<string, unknown> } };
    expect(response.status).toBe(200);
    expect(payload.account_isolated).toBe(true);
    expect(updatePayload.auth?.oauth_server?.enabled).toBe(true);
    expect(updatePayload.auth?.oauth_server?.allow_dynamic_registration).toBe(true);
    expect(String(updatePayload.auth?.oauth_server?.issuer)).toMatch(/\/auth\/v1$/);
    expect(updatePayload.auth?.oauth_server?.signing_alg).toBe("ES256");
    expect(typeof updatePayload.auth?.oauth_server?.key_id).toBe("string");
    expect(Array.isArray(updatePayload.auth?.oauth_server?.jwt_keys)).toBe(true);
    expect(updatePayload.auth?.oauth_server?.jwt_jwks).toMatchObject({ keys: expect.any(Array) });
    expect(typeof updatePayload.auth?.oauth_server?.migrated_at).toBe("string");
    expect(restartSpy).toHaveBeenCalledWith("proj_1");

    const jwtKeys = updatePayload.auth?.oauth_server?.jwt_keys as Array<Record<string, unknown>>;
    const signingKey = jwtKeys.find((key) => key.alg === "ES256");
    const legacyKey = jwtKeys.find((key) => key.kid === "legacy-hs256");
    expect(jwtKeys).toHaveLength(1);
    expect(signingKey).toMatchObject({
      kty: "EC",
      alg: "ES256",
      use: "sig",
      key_ops: ["sign"],
    });
    expect(legacyKey).toBeUndefined();

    projectSpy.mockRestore();
    settingsSpy.mockRestore();
    updateSpy.mockRestore();
    restartSpy.mockRestore();
    sqlSpy.mockRestore();
  });

  test("GET /oauth-clients proxies to GoTrue admin client listing", async () => {
    const keyMaterial = await generateOidcJwtKeyMaterial("jwt");
    const projectSpy = spyOn(projectService, "getProject").mockResolvedValue({
      id: "proj_id",
      ref: "proj_1",
      organization_id: "org_1",
      name: "Project 1",
      db_name: "supa_proj_1",
      db_user: "role_proj_1",
      db_password: "pw",
      jwt_secret: "jwt",
      anon_key: "anon",
      service_role_key: "service",
      s3_bucket: "bucket",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      config: {
        auth: {
          oauth_server: {
            enabled: true,
            allow_dynamic_registration: true,
          },
        },
      },
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    } as never);
    const settingsSpy = spyOn(projectService, "getProjectSettings").mockResolvedValue({
      auth: {
        oauth_server: {
          enabled: true,
          allow_dynamic_registration: true,
        },
      },
    } as never);
    const sqlSpy = spyOn(dbModule, "sql");
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("SELECT config, organization_id")) {
        return [{
          config: {
            auth: {
              oauth_server: {
                enabled: true,
                allow_dynamic_registration: true,
                issuer: "https://api.example.com/auth/v1",
                jwt_keys: keyMaterial.jwt_keys,
                jwt_jwks: keyMaterial.jwt_jwks,
              },
            },
            postgrest_port: 3100,
            gotrue_port: 3200,
          },
          organization_id: "org_1",
          jwt_secret: "jwt",
        }];
      }
      return [];
    });

    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ clients: [] }), {
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch;

    try {
      const response = await request("/v1/projects/proj_1/auth/oauth-clients", {
        headers: { Authorization: "Bearer dev-master-token" },
      });

      expect(response.status).toBe(200);
      expect(calls[0]?.url).toBe("http://127.0.0.1:3200/admin/oauth/clients");
      const headers = new Headers(calls[0]?.init?.headers);
      const authorization = headers.get("authorization") ?? "";
      const adminToken = authorization.replace(/^Bearer\s+/i, "");
      const jwtHeader = JSON.parse(Buffer.from(adminToken.split(".")[0] ?? "", "base64url").toString("utf8"));
      expect(headers.get("x-project-ref")).toBe("proj_1");
      expect(headers.get("apikey")).toBe(adminToken);
      expect(adminToken).not.toBe("service");
      expect(jwtHeader).toMatchObject({ alg: "ES256", kid: keyMaterial.key_id });
    } finally {
      projectSpy.mockRestore();
      settingsSpy.mockRestore();
      sqlSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("POST /oauth-clients sends empty secret for public GoTrue clients", async () => {
    const keyMaterial = await generateOidcJwtKeyMaterial("jwt");
    const projectSpy = spyOn(projectService, "getProject").mockResolvedValue({
      id: "proj_id",
      ref: "proj_1",
      organization_id: "org_1",
      name: "Project 1",
      db_name: "supa_proj_1",
      db_user: "role_proj_1",
      db_password: "pw",
      jwt_secret: "jwt",
      anon_key: "anon",
      service_role_key: "service",
      s3_bucket: "bucket",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      config: {
        auth: {
          oauth_server: {
            enabled: true,
            allow_dynamic_registration: true,
          },
        },
      },
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    } as never);
    const sqlSpy = spyOn(dbModule, "sql");
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("SELECT config, organization_id")) {
        return [{
          config: {
            auth: {
              oauth_server: {
                enabled: true,
                allow_dynamic_registration: true,
                issuer: "https://api.example.com/auth/v1",
                jwt_keys: keyMaterial.jwt_keys,
                jwt_jwks: keyMaterial.jwt_jwks,
              },
            },
            postgrest_port: 3100,
            gotrue_port: 3200,
          },
          organization_id: "org_1",
          jwt_secret: "jwt",
        }];
      }
      return [];
    });

    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ client_id: "client_1" }), {
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch;

    try {
      const response = await request("/v1/projects/proj_1/auth/oauth-clients", {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-master-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_type: "public",
          redirect_uris: ["https://app.example.com/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          client_name: "Public app",
        }),
      });

      expect(response.status).toBe(200);
      expect(calls[0]?.url).toBe("http://127.0.0.1:3200/admin/oauth/clients");
      const forwarded = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
      expect(forwarded.client_type).toBe("public");
      expect(forwarded.token_endpoint_auth_method).toBe("none");
      expect(forwarded.client_secret).toBe("");
    } finally {
      projectSpy.mockRestore();
      sqlSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});
