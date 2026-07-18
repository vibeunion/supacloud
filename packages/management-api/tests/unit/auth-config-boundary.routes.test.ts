import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { projectConfigRoutes } from "../../src/routes/project-config";
import { authRoutes } from "../../src/routes/auth";
import { projectService } from "../../src/services";
import {
  SupAuthDependentRefreshError,
  tenantRuntimeService,
} from "../../src/services/tenant-runtime.service";

const app = new Elysia().use(projectConfigRoutes);
const rawAuthApp = new Elysia().use(authRoutes);
const authHeaders = { Authorization: "Bearer dev-master-token" };
const originalOwnerRef = config.authRuntimeOwnerRef;
const originalGetProjectSettings = projectService.getProjectSettings;
const originalUpdateProjectSettings = projectService.updateProjectSettings;
const originalApplyAuthConfig = tenantRuntimeService.applyAuthConfig;
const authApplyInternals = tenantRuntimeService as unknown as {
  applyGotrueAuthConfig: (ref: string) => Promise<{
    authRuntime: { mode: "local" | "owner" };
    pgrstPort: number;
    status: unknown;
  }>;
  refreshProjectPostgrestVerifier: (ref: string, pgrstPort: number) => Promise<void>;
  refreshSharedAuthDependents: (
    ownerRef: string,
    systemctlMode?: "best-effort" | "checked",
  ) => Promise<void>;
};
const originalApplyGotrueAuthConfig = authApplyInternals.applyGotrueAuthConfig;
const originalRefreshProjectPostgrestVerifier = authApplyInternals.refreshProjectPostgrestVerifier;
const originalRefreshSharedAuthDependents = authApplyInternals.refreshSharedAuthDependents;

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers || {}) },
  }));
}

function rawAuthRequest(path: string, init: RequestInit = {}) {
  return rawAuthApp.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers || {}) },
  }));
}

afterEach(() => {
  config.authRuntimeOwnerRef = originalOwnerRef;
  projectService.getProjectSettings = originalGetProjectSettings;
  projectService.updateProjectSettings = originalUpdateProjectSettings;
  tenantRuntimeService.applyAuthConfig = originalApplyAuthConfig;
  authApplyInternals.applyGotrueAuthConfig = originalApplyGotrueAuthConfig;
  authApplyInternals.refreshProjectPostgrestVerifier = originalRefreshProjectPostgrestVerifier;
  authApplyInternals.refreshSharedAuthDependents = originalRefreshSharedAuthDependents;
});

describe("SupAuth auth config boundary", () => {
  test("requires authentication for auth config reads", async () => {
    const response = await app.handle(new Request("http://localhost/v1/projects/tenant-a/config/auth"));
    expect(response.status).toBe(401);
  });

  test("blocks dependent auth config reads and writes", async () => {
    config.authRuntimeOwnerRef = "auth-owner";

    const getResponse = await request("/v1/projects/tenant-a/config/auth");
    expect(getResponse.status).toBe(409);
    expect((await getResponse.json()).code).toBe("AUTH_RUNTIME_MANAGED_BY_OWNER");

    const patchResponse = await request("/v1/projects/tenant-a/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ EXTERNAL_EMAIL_ENABLED: false }),
    });
    expect(patchResponse.status).toBe(409);
  });

  test("allowlists owner auth config fields and masks hook secrets", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.getProjectSettings = async () => ({
      auth: {
        jwt_secret: "must-not-leak",
        hooks: {
          custom_access_token_hook: {
            enabled: true,
            uri: "pg-functions://postgrest/auth_hook",
            secrets: "must-mask",
          },
        },
        smtp: { pass: "must-mask" },
        saml: { private_key: "must-not-leak" },
      },
    } as never);

    const response = await request("/v1/projects/auth-owner/config/auth");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.jwt_secret).toBeUndefined();
    expect(body.saml).toBeUndefined();
    expect(body.hook_custom_access_token_secrets).toBe("********");
    expect(body.smtp_pass).toBe("********");
  });

  test("returns effective defaults and round-trips canonical session policy values", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = { auth: {} };
    let applyCalls = 0;
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => {
      applyCalls += 1;
      return {} as never;
    };

    const initial = await request("/v1/projects/tenant-a/config/auth");
    const initialBody = await initial.json();
    expect(initialBody).toMatchObject({
      jwt_exp: 3600,
      jwt_expiry: 3600,
      refresh_token_rotation_enabled: true,
      security_refresh_token_reuse_interval: 10,
      security_update_password_require_reauthentication: true,
      password_min_length: 8,
      sessions_inactivity_timeout: null,
      sessions_single_per_user: false,
      sessions_timebox: null,
    });

    const response = await request("/v1/projects/tenant-a/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jwt_exp: 7200,
        security_refresh_token_rotation_enabled: false,
        security_refresh_token_rotation_reuse_interval: 17,
        security_update_password_require_reauthentication: false,
        password_min_length: 12,
        sessions_inactivity_timeout: "30m",
        sessions_single_per_user: true,
        sessions_timebox: 86_400,
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(applyCalls).toBe(1);
    expect(body).toMatchObject({
      jwt_exp: 7200,
      jwt_expiry: 7200,
      refresh_token_rotation_enabled: false,
      security_refresh_token_reuse_interval: 17,
      security_update_password_require_reauthentication: false,
      password_min_length: 12,
      sessions_inactivity_timeout: 1800,
      sessions_single_per_user: true,
      sessions_timebox: 86_400,
    });
    expect((settings.auth as Record<string, unknown>)).toMatchObject({
      jwt_expiry: 7200,
      refresh_token_rotation_enabled: false,
      security_refresh_token_reuse_interval: 17,
      sessions_inactivity_timeout: 1800,
      sessions_timebox: 86_400,
    });
    expect((settings.auth as Record<string, unknown>).jwt_exp).toBeUndefined();
    expect((settings.auth as Record<string, unknown>).security_refresh_token_rotation_reuse_interval).toBeUndefined();
  });

  test("rejects invalid session policy before persistence or runtime apply", async () => {
    config.authRuntimeOwnerRef = "";
    projectService.getProjectSettings = async () => ({ auth: {} } as never);
    let updateCalls = 0;
    let applyCalls = 0;
    projectService.updateProjectSettings = async () => {
      updateCalls += 1;
      return { auth: {} } as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => {
      applyCalls += 1;
      return {} as never;
    };

    const response = await request("/v1/projects/tenant-a/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password_min_length: 5 }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "INVALID_AUTH_SESSION_POLICY",
      field: "password_min_length",
    });
    expect(updateCalls).toBe(0);
    expect(applyCalls).toBe(0);
  });

  test("canonicalizes the legacy auth config PATCH route through the same apply path", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = { auth: {} };
    let applyCalls = 0;
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => {
      applyCalls += 1;
      return {} as never;
    };

    const response = await rawAuthRequest("/v1/projects/tenant-a/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jwt_exp: 4800,
        security_refresh_token_rotation_reuse_interval: 11,
        enable_signup: false,
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(applyCalls).toBe(1);
    expect(body).toMatchObject({
      jwt_expiry: 4800,
      security_refresh_token_reuse_interval: 11,
      enable_signup: false,
    });
    expect(body.jwt_exp).toBeUndefined();
    expect(body.security_refresh_token_rotation_reuse_interval).toBeUndefined();
  });

  test("reports local runtime apply failure without undoing the persisted desired config", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = { auth: {} };
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => {
      throw new Error("systemctl restart failed");
    };

    const response = await request("/v1/projects/tenant-a/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt_expiry: 5400 }),
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: "AUTH_RUNTIME_APPLY_FAILED",
      persisted: true,
      runtime_applied: false,
      runtime_mode: "local",
    });
    expect((settings.auth as Record<string, unknown>).jwt_expiry).toBe(5400);
  });

  test("preserves owner dependent refresh failure semantics", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    let settings: Record<string, unknown> = {
      auth: { oauth_server: { jwt_jwks: { keys: [{ kid: "old" }] } } },
    };
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => {
      throw new SupAuthDependentRefreshError(["tenant-a"]);
    };

    const response = await request("/v1/projects/auth-owner/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oauth_server: { jwt_jwks: { keys: [{ kid: "new" }] } },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
      persisted: true,
      runtime_applied: true,
      dependents_applied: false,
      dependent_status: "failed",
      failed_dependents: ["tenant-a"],
      runtime_mode: "owner",
      authority_project_ref: "auth-owner",
    });
  });

  test("reports unknown dependent state without misclassifying the applied owner runtime", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    let settings: Record<string, unknown> = {
      auth: { oauth_server: { jwt_jwks: { keys: [{ kid: "old" }] } } },
    };
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => {
      throw new SupAuthDependentRefreshError([]);
    };

    const response = await request("/v1/projects/auth-owner/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oauth_server: { jwt_jwks: { keys: [{ kid: "new" }] } },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
      persisted: true,
      runtime_applied: true,
      dependents_applied: false,
      dependent_status: "unknown",
      failed_dependents: [],
    });
  });

  test("shared settings alias hides auth config and rejects auth writes", async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    projectService.getProjectSettings = async () => ({
      auth: { jwt_secret: "dependent-secret" },
      api_domain: "tenant-a.api.example.com",
    });
    let updateCalls = 0;
    projectService.updateProjectSettings = async () => {
      updateCalls += 1;
      return {
        auth: { smtp: { pass: "dependent-secret" } },
        api_domain: "updated.api.example.com",
      } as never;
    };

    const getResponse = await request("/v1/projects/tenant-a/settings");
    const body = await getResponse.json();
    expect(getResponse.status).toBe(200);
    expect(body.auth).toBeUndefined();
    expect(body.auth_runtime).toEqual({
      mode: "shared",
      authority_project_ref: "auth-owner",
      configuration_management: "owner_only",
    });

    const putResponse = await request("/v1/projects/tenant-a/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { enable_signup: false } }),
    });
    expect(putResponse.status).toBe(409);
    expect(updateCalls).toBe(0);

    const safePutResponse = await request("/v1/projects/tenant-a/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_domain: "updated.api.example.com" }),
    });
    const safePutBody = await safePutResponse.json();
    expect(safePutResponse.status).toBe(200);
    expect(safePutBody.auth).toBeUndefined();
    expect(safePutBody.auth_runtime).toEqual({
      mode: "shared",
      authority_project_ref: "auth-owner",
      configuration_management: "owner_only",
    });
    expect(updateCalls).toBe(1);
  });
});

describe("TenantRuntimeService auth config runtime impact", () => {
  test("session-only owner changes apply GoTrue without PostgREST refresh or dependent fan-out", async () => {
    const events: string[] = [];
    authApplyInternals.applyGotrueAuthConfig = async () => {
      events.push("gotrue");
      return { authRuntime: { mode: "owner" }, pgrstPort: 3101, status: {} };
    };
    authApplyInternals.refreshProjectPostgrestVerifier = async () => {
      events.push("postgrest");
    };
    authApplyInternals.refreshSharedAuthDependents = async () => {
      events.push("dependents");
    };

    await originalApplyAuthConfig.call(
      tenantRuntimeService,
      "auth-owner",
      { jwt_expiry: 3600, sessions_single_per_user: false },
      { jwt_expiry: 7200, sessions_single_per_user: true },
    );

    expect(events).toEqual(["gotrue"]);
  });

  test("owner signing changes refresh local PostgREST and fan out dependents exactly once", async () => {
    const events: string[] = [];
    authApplyInternals.applyGotrueAuthConfig = async () => {
      events.push("gotrue");
      return { authRuntime: { mode: "owner" }, pgrstPort: 3102, status: {} };
    };
    authApplyInternals.refreshProjectPostgrestVerifier = async (ref, pgrstPort) => {
      events.push(`postgrest:${ref}:${pgrstPort}`);
    };
    authApplyInternals.refreshSharedAuthDependents = async (ownerRef, systemctlMode) => {
      events.push(`dependents:${ownerRef}:${systemctlMode}`);
    };

    await originalApplyAuthConfig.call(
      tenantRuntimeService,
      "auth-owner",
      { oauth_server: { jwt_jwks: { keys: [{ kid: "old" }] } } },
      { oauth_server: { jwt_jwks: { keys: [{ kid: "new" }] } } },
    );

    expect(events).toEqual([
      "gotrue",
      "postgrest:auth-owner:3102",
      "dependents:auth-owner:checked",
    ]);
  });
});
