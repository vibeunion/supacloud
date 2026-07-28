// @supacloud-test-isolate
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { projectConfigRoutes } from "../../src/routes/project-config";
import { authRoutes } from "../../src/routes/auth";
import { projectService } from "../../src/services";
import {
  SupAuthDependentRefreshError,
  tenantRuntimeService,
  renderManagedGoTrueSecretEnv,
} from "../../src/services/tenant-runtime.service";
import { projectControlSecretsService } from "../../src/services/project-control-secrets.service";

const app = new Elysia().use(projectConfigRoutes);
const rawAuthApp = new Elysia().use(authRoutes);
const authHeaders = { Authorization: "Bearer dev-master-token" };
const originalOwnerRef = config.authRuntimeOwnerRef;
const originalGetProjectSettings = projectService.getProjectSettings;
const originalUpdateProjectSettings = projectService.updateProjectSettings;
const originalApplyAuthConfig = tenantRuntimeService.applyAuthConfig;
const originalListControlSecrets = projectControlSecretsService.listStatuses;
const originalGetControlSecret = projectControlSecretsService.getStatus;
const originalUpsertControlSecret = projectControlSecretsService.upsert;
const originalReadControlSecret = projectControlSecretsService.readValue;
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
  projectControlSecretsService.listStatuses = originalListControlSecrets;
  projectControlSecretsService.getStatus = originalGetControlSecret;
  projectControlSecretsService.upsert = originalUpsertControlSecret;
  projectControlSecretsService.readValue = originalReadControlSecret;
  authApplyInternals.applyGotrueAuthConfig = originalApplyGotrueAuthConfig;
  authApplyInternals.refreshProjectPostgrestVerifier = originalRefreshProjectPostgrestVerifier;
  authApplyInternals.refreshSharedAuthDependents = originalRefreshSharedAuthDependents;
});

describe("SupAuth auth config boundary", () => {
  beforeEach(() => {
    projectControlSecretsService.listStatuses = async () => [];
    projectControlSecretsService.getStatus = async (_ref, scope, name) => ({
      scope: scope as "captcha" | "connector" | "auth-hook",
      name,
      configured: false,
      value: "********",
      updated_at: null,
    });
    projectControlSecretsService.upsert = async (_ref, scope, name) => ({
      scope: scope as "captcha" | "connector" | "auth-hook",
      name,
      configured: true,
      value: "********",
      updated_at: "2026-07-19T00:00:00.000Z",
    });
  });

  test("requires authentication for auth config reads", async () => {
    const response = await app.handle(new Request("http://localhost/v1/projects/tenant-a/config/auth"));
    expect(response.status).toBe(401);
  });

  test("exposes stored Passkey configuration through the official Management API shape", async () => {
    config.authRuntimeOwnerRef = "";
    projectService.getProjectSettings = async () => ({
      auth: {
        passkey: { enabled: true },
        passkey_enabled: true,
        webauthn: { rp_id: "login.example.com" },
        mfa: {
          totp: { enroll_enabled: true },
          webauthn: { enroll_enabled: true },
        },
        mfa_web_authn_enroll_enabled: true,
        mfa_web_authn_verify_enabled: true,
        webauthn_rp_display_name: "Stored RP",
        webauthn_rp_id: "login.example.com",
        webauthn_rp_origins: ["https://login.example.com"],
        MFA: { Web_Authn: { verify_enabled: true } },
      },
    } as never);

    const rawResponse = await rawAuthRequest("/v1/projects/tenant-a/auth/config");
    const rawBody = await rawResponse.json();
    expect(rawResponse.status).toBe(200);
    expect(rawBody.passkey_enabled).toBe(true);
    expect(rawBody.webauthn_rp_display_name).toBe("Stored RP");
    expect(rawBody.webauthn_rp_id).toBe("login.example.com");

    const studioResponse = await request("/v1/projects/tenant-a/config/auth");
    const studioBody = await studioResponse.json();
    expect(studioResponse.status).toBe(200);
    expect(studioBody).toMatchObject({
      mfa_web_authn_enroll_enabled: null,
      mfa_web_authn_verify_enabled: null,
      passkey_enabled: true,
      webauthn_rp_display_name: "Stored RP",
      webauthn_rp_id: "login.example.com",
      webauthn_rp_origins: "https://login.example.com",
    });
  });

  test("accepts official experimental Passkey configuration on both auth config routes", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = { auth: {} };
    let updateCalls = 0;
    let applyCalls = 0;
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      updateCalls += 1;
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => {
      applyCalls += 1;
      return {} as never;
    };

    const passkeyConfig = {
      passkey_enabled: true,
      passkey_max_passkeys_per_user: 8,
      webauthn_rp_display_name: "Example App",
      webauthn_rp_id: "example.com",
      webauthn_rp_origins: ["https://example.com", "https://app.example.com"],
    };

    const configEndpoints = [
      { send: request, path: "/v1/projects/tenant-a/config/auth" },
      { send: rawAuthRequest, path: "/v1/projects/tenant-a/auth/config" },
    ];
    for (const endpoint of configEndpoints) {
      const response = await endpoint.send(endpoint.path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(passkeyConfig),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        passkey_enabled: true,
        webauthn_rp_id: "example.com",
        webauthn_rp_origins: "https://example.com,https://app.example.com",
      });
    }
    expect(updateCalls).toBe(2);
    expect(applyCalls).toBe(2);
    expect((settings.auth as Record<string, unknown>).webauthn_rp_origins)
      .toBe("https://example.com,https://app.example.com");
  });

  test("rejects invalid Passkey relying-party settings before persistence", async () => {
    config.authRuntimeOwnerRef = "";
    let updateCalls = 0;
    projectService.getProjectSettings = async () => ({ auth: {} } as never);
    projectService.updateProjectSettings = async () => {
      updateCalls += 1;
      return { auth: {} } as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => ({} as never);

    for (const endpoint of [
      { send: request, path: "/v1/projects/tenant-a/config/auth" },
      { send: rawAuthRequest, path: "/v1/projects/tenant-a/auth/config" },
    ]) {
      const response = await endpoint.send(endpoint.path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passkey_enabled: true,
          webauthn_rp_display_name: "Example App",
          webauthn_rp_id: "example.com",
          webauthn_rp_origins: "http://example.com",
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "INVALID_PASSKEY_CONFIG",
        experimental: true,
      });
    }
    expect(updateCalls).toBe(0);
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

  test("does not treat legacy inline hook secrets as managed", async () => {
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
    expect(body.hook_custom_access_token_secrets).toBeNull();
    expect(body.hook_custom_access_token_secrets_configured).toBe(false);
    expect(body.smtp_pass).toBe("********");
  });

  test("fails closed when enabled GoTrue capabilities lack managed secrets", async () => {
    projectControlSecretsService.readValue = async () => null;

    await expect(renderManagedGoTrueSecretEnv("tenant-a", {
      external: { github: { client_id: "client", client_secret: "legacy-inline" } },
    })).rejects.toThrow('Missing managed connector secret "github"');
    await expect(renderManagedGoTrueSecretEnv("tenant-a", {
      security_captcha_enabled: true,
      security_captcha_provider: "hcaptcha",
      security_captcha_secret: "legacy-inline",
    })).rejects.toThrow('Missing managed captcha secret "hcaptcha"');
    await expect(renderManagedGoTrueSecretEnv("tenant-a", {
      hooks: {
        custom_access_token_hook: {
          enabled: true,
          uri: "pg-functions://postgres/auth-hook",
          secrets: "legacy-inline",
        },
      },
    })).rejects.toThrow('Missing managed auth-hook secret "custom_access_token_hook"');
  });

  test("recursively masks raw auth secrets and flat aliases", async () => {
    config.authRuntimeOwnerRef = "";
    projectService.getProjectSettings = async () => ({
      auth: {
        jwt_secret: "jwt-inline-secret",
        smtp: { pass: "smtp-inline-secret", nested: { api_key: "nested-api-secret" } },
        smtp_pass: "flat-smtp-secret",
        saml: { private_key: "saml-private-key", private_key_next: "saml-next-key" },
        saml_private_key: "flat-saml-key",
        security_captcha_secret: "captcha-inline-secret",
        external_github_secret: "github-flat-secret",
        nimbus_oauth_client_secret: "nimbus-flat-secret",
        hook_custom_access_token_secrets: "hook-flat-secret",
        external: {
          github: { client_id: "github-client", client_secret: "github-inline-secret" },
        },
        hooks: {
          custom_access_token_hook: { enabled: true, secrets: "hook-inline-secret" },
        },
        oauth_server: {
          jwt_keys: [{ kid: "private", d: "private-jwk-d", x: "public-x" }],
          jwt_jwks: { keys: [{ kid: "legacy", k: "legacy-hs-secret" }] },
        },
      },
    } as never);
    projectControlSecretsService.listStatuses = async (_ref, scope) => {
      if (scope === "connector") {
        return ["github", "nimbus"].map((name) => ({ scope, name, configured: true, value: "********", updated_at: null }));
      }
      if (scope === "auth-hook") {
        return [{ scope, name: "custom_access_token_hook", configured: true, value: "********", updated_at: null }];
      }
      return [];
    };
    projectControlSecretsService.getStatus = async (_ref, scope, name) => ({
      scope: scope as "captcha" | "connector" | "auth-hook",
      name,
      configured: scope === "captcha",
      value: "********",
      updated_at: null,
    });

    const response = await rawAuthRequest("/v1/projects/tenant-a/auth/config");
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    for (const secret of [
      "jwt-inline-secret",
      "smtp-inline-secret",
      "nested-api-secret",
      "flat-smtp-secret",
      "saml-private-key",
      "saml-next-key",
      "flat-saml-key",
      "captcha-inline-secret",
      "github-flat-secret",
      "nimbus-flat-secret",
      "hook-flat-secret",
      "github-inline-secret",
      "hook-inline-secret",
      "private-jwk-d",
      "legacy-hs-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(body.jwt_secret).toBe("********");
    expect(body.jwt_secret_configured).toBe(true);
    expect(body.smtp.pass).toBe("********");
    expect(body.smtp.pass_configured).toBe(true);
    expect(body.smtp.nested.api_key).toBe("********");
    expect(body.smtp.nested.api_key_configured).toBe(true);
    expect(body.smtp_pass).toBe("********");
    expect(body.saml.private_key).toBe("********");
    expect(body.saml.private_key_next).toBe("********");
    expect(body.external_github_secret).toBe("********");
    expect(body.external_github_secret_configured).toBe(true);
    expect(body.nimbus_oauth_client_secret).toBe("********");
    expect(body.nimbus_oauth_client_secret_configured).toBe(true);
    expect(body.hook_custom_access_token_secrets).toBe("********");
    expect(body.hook_custom_access_token_secrets_configured).toBe(true);
    expect(body.external.github.client_secret).toBe("********");
    expect(body.external.github.client_secret_configured).toBe(true);
    expect(body.hooks.custom_access_token_hook.secrets).toBe("********");
    expect(body.oauth_server.jwt_keys[0].d).toBe("********");
    expect(body.oauth_server.jwt_jwks.keys[0].k).toBe("********");
  });

  test("never returns stored connector secrets from provider read routes", async () => {
    config.authRuntimeOwnerRef = "";
    projectService.getProjectSettings = async () => ({
      auth: {
        external: {
          github: { client_id: "github-client", client_secret: "github-stored-secret" },
          wechat: { client_id: "wechat-client", client_secret: "wechat-stored-secret" },
        },
      },
    } as never);
    projectControlSecretsService.listStatuses = async (_ref, scope) => scope === "connector"
      ? [{ scope, name: "github", configured: true, value: "********", updated_at: null }]
      : [];
    projectControlSecretsService.getStatus = async (_ref, scope, name) => ({
      scope: scope as "captcha" | "connector" | "auth-hook",
      name,
      configured: name === "github",
      value: "********",
      updated_at: null,
    });

    for (const path of [
      "/v1/projects/tenant-a/auth/providers",
      "/v1/projects/tenant-a/auth/providers/github",
      "/v1/projects/tenant-a/auth/studio/providers",
      "/v1/projects/tenant-a/auth/wechat/providers",
    ]) {
      const response = await rawAuthRequest(path);
      const serialized = await response.text();
      expect(response.status).toBe(200);
      expect(serialized).not.toContain("github-stored-secret");
      expect(serialized).not.toContain("wechat-stored-secret");
    }
  });

  test("does not write masked values back over existing auth secrets", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = {
      auth: {
        jwt_secret: "jwt-original",
        smtp: { pass: "smtp-original", host: "smtp.example.com" },
        smtp_pass: "flat-smtp-original",
        saml: { private_key: "saml-original", private_key_next: "saml-next-original" },
        saml_private_key: "flat-saml-original",
        external: { github: { client_id: "old-client" } },
      },
    };
    let upsertCalls = 0;
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    projectControlSecretsService.upsert = async (_ref, scope, name) => {
      upsertCalls += 1;
      return { scope: scope as "captcha" | "connector" | "auth-hook", name, configured: true, value: "********", updated_at: null };
    };
    tenantRuntimeService.applyAuthConfig = async () => ({} as never);

    const response = await rawAuthRequest("/v1/projects/tenant-a/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jwt_secret: "********",
        smtp: { pass: "********", host: "smtp.updated.example.com" },
        smtp_pass: "****",
        saml: { private_key: "********", private_key_next: "****" },
        saml_private_key: "********",
        external: { github: { client_id: "new-client", client_secret: "********" } },
        security_captcha_secret: "********",
        hooks: { custom_access_token_hook: { secrets: "********", enabled: true } },
      }),
    });
    const persistedAuth = settings.auth as Record<string, unknown>;
    const persistedSmtp = persistedAuth.smtp as Record<string, unknown>;
    const persistedSaml = persistedAuth.saml as Record<string, unknown>;
    const persistedExternal = persistedAuth.external as Record<string, Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(upsertCalls).toBe(0);
    expect(persistedAuth.jwt_secret).toBe("jwt-original");
    expect(persistedSmtp.pass).toBe("smtp-original");
    expect(persistedSmtp.host).toBe("smtp.updated.example.com");
    expect(persistedAuth.smtp_pass).toBe("flat-smtp-original");
    expect(persistedSaml.private_key).toBe("saml-original");
    expect(persistedSaml.private_key_next).toBe("saml-next-original");
    expect(persistedAuth.saml_private_key).toBe("flat-saml-original");
    expect(persistedExternal.github.client_id).toBe("new-client");
    expect(persistedExternal.github.client_secret).toBeUndefined();
    expect(JSON.stringify(persistedAuth)).not.toContain("********");
  });

  test("moves nested and flat control secrets out of raw auth config writes", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = { auth: {} };
    const secretWrites: string[] = [];
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    projectControlSecretsService.upsert = async (_ref, scope, name) => {
      secretWrites.push(`${scope}:${name}`);
      return { scope: scope as "captcha" | "connector" | "auth-hook", name, configured: true, value: "********", updated_at: null };
    };
    tenantRuntimeService.applyAuthConfig = async () => ({} as never);

    const response = await rawAuthRequest("/v1/projects/tenant-a/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        external_github_secret: "github-new-secret",
        nimbus_oauth_client_secret: "nimbus-new-secret",
        hook_custom_access_token_secrets: "custom-hook-secret",
        security_captcha_provider: "hcaptcha",
        security_captcha_secret: "captcha-new-secret",
        external: { google: { client_id: "google-client", client_secret: "google-new-secret" } },
        hooks: { before_user_created_hook: { enabled: true, secrets: "before-user-hook-secret" } },
      }),
    });
    const persistedAuth = settings.auth as Record<string, unknown>;
    const persistedExternal = persistedAuth.external as Record<string, Record<string, unknown>>;
    const persistedHooks = persistedAuth.hooks as Record<string, Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(secretWrites).toHaveLength(6);
    expect(secretWrites).toEqual(expect.arrayContaining([
      "connector:github",
      "connector:nimbus",
      "connector:google",
      "captcha:hcaptcha",
      "auth-hook:custom_access_token_hook",
      "auth-hook:before_user_created_hook",
    ]));
    expect(persistedAuth.external_github_secret).toBeUndefined();
    expect(persistedAuth.nimbus_oauth_client_secret).toBeUndefined();
    expect(persistedAuth.hook_custom_access_token_secrets).toBeUndefined();
    expect(persistedAuth.security_captcha_secret).toBeUndefined();
    expect(persistedExternal.google.client_secret).toBeUndefined();
    expect(persistedHooks.before_user_created_hook.secrets).toBeUndefined();
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

  test("rejects invalid SITE_URL values before persistence or runtime apply", async () => {
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
      body: JSON.stringify({ SITE_URL: "https://app.example.com/?next=unsafe" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_AUTH_URL_CONFIG",
      field: "SITE_URL",
    });
    expect(updateCalls).toBe(0);
    expect(applyCalls).toBe(0);
  });

  test("persists valid intranet URLs under canonical auth keys", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = {
      auth: {
        SITE_URL: "https://legacy.example.com",
        URI_ALLOW_LIST: "https://legacy.example.com/callback",
      },
    };
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

    const response = await request("/v1/projects/tenant-a/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        site_url: "http://192.168.200.112:3010",
        uri_allow_list: "http://192.168.200.112:3010/callback",
      }),
    });

    const persistedAuth = settings.auth as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(applyCalls).toBe(1);
    expect(persistedAuth).toMatchObject({
      site_url: "http://192.168.200.112:3010",
      uri_allow_list: "http://192.168.200.112:3010/callback",
    });
    expect(persistedAuth.SITE_URL).toBeUndefined();
    expect(persistedAuth.URI_ALLOW_LIST).toBeUndefined();
  });

  test("rejects invalid URL config on the Studio PATCH route before any write or apply", async () => {
    config.authRuntimeOwnerRef = "";
    projectService.getProjectSettings = async () => ({ auth: {} } as never);
    let settingsWrites = 0;
    let secretWrites = 0;
    let applyCalls = 0;
    projectService.updateProjectSettings = async () => {
      settingsWrites += 1;
      return { auth: {} } as never;
    };
    projectControlSecretsService.upsert = async (_ref, scope, name) => {
      secretWrites += 1;
      return { scope, name, configured: true, value: "********", updated_at: null };
    };
    tenantRuntimeService.applyAuthConfig = async () => {
      applyCalls += 1;
      return {} as never;
    };

    const response = await rawAuthRequest("/v1/projects/tenant-a/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uri_allow_list: ["https://app.example.com/callback"],
        external: { github: { client_id: "client", client_secret: "must-not-write" } },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_AUTH_URL_CONFIG",
      field: "URI_ALLOW_LIST",
    });
    expect(settingsWrites).toBe(0);
    expect(secretWrites).toBe(0);
    expect(applyCalls).toBe(0);
  });

  test("normalizes URL aliases before the Studio PATCH persists and applies them", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = {
      auth: {
        SITE_URL: "https://legacy.example.com",
        URI_ALLOW_LIST: "https://legacy.example.com/callback",
      },
    };
    let appliedAuth: Record<string, unknown> | null = null;
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async (_ref, _currentAuth, nextAuth) => {
      appliedAuth = nextAuth;
      return {} as never;
    };

    const response = await rawAuthRequest("/v1/projects/tenant-a/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        SITE_URL: " http://192.168.200.112:3010 ",
        URI_ALLOW_LIST: " http://192.168.200.112:3010/callback, https://*.example.com/** ",
      }),
    });
    const persistedAuth = settings.auth as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(persistedAuth).toMatchObject({
      site_url: "http://192.168.200.112:3010",
      uri_allow_list: "http://192.168.200.112:3010/callback,https://*.example.com/**",
    });
    expect(persistedAuth.SITE_URL).toBeUndefined();
    expect(persistedAuth.URI_ALLOW_LIST).toBeUndefined();
    expect(appliedAuth).toEqual(persistedAuth);
  });

  test("reads canonical URL fields from lowercase and legacy uppercase settings", async () => {
    config.authRuntimeOwnerRef = "";
    const storedAuthConfigs = [
      {
        site_url: "https://canonical.example.com",
        uri_allow_list: "https://canonical.example.com/callback",
      },
      {
        SITE_URL: "https://legacy.example.com",
        URI_ALLOW_LIST: "https://legacy.example.com/callback",
      },
    ];

    for (const storedAuth of storedAuthConfigs) {
      projectService.getProjectSettings = async () => ({ auth: storedAuth } as never);
      const studioResponse = await rawAuthRequest("/v1/projects/tenant-a/auth/config");
      const studioBody = await studioResponse.json();
      const compatibilityResponse = await request("/v1/projects/tenant-a/config/auth");
      const compatibilityBody = await compatibilityResponse.json();
      const expectedSiteUrl = storedAuth.site_url ?? storedAuth.SITE_URL;
      const expectedAllowList = storedAuth.uri_allow_list ?? storedAuth.URI_ALLOW_LIST;

      expect(studioResponse.status).toBe(200);
      expect(compatibilityResponse.status).toBe(200);
      expect(studioBody.site_url).toBe(expectedSiteUrl);
      expect(studioBody.uri_allow_list).toBe(expectedAllowList);
      expect(compatibilityBody.site_url).toBe(expectedSiteUrl);
      expect(compatibilityBody.uri_allow_list).toBe(expectedAllowList);
    }
  });

  test("does not block unrelated auth updates on existing legacy URL aliases", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = {
      auth: {
        site_url: "https://canonical.example.com",
        SITE_URL: "https://legacy.example.com",
      },
    };
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => ({} as never);

    const response = await request("/v1/projects/tenant-a/config/auth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enable_signup: false }),
    });

    expect(response.status).toBe(200);
    expect((settings.auth as Record<string, unknown>).enable_signup).toBe(false);
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

  test("accepts legacy provider linking input but persists only the canonical map", async () => {
    config.authRuntimeOwnerRef = "";
    let settings: Record<string, unknown> = { auth: {} };
    projectService.getProjectSettings = async () => settings as never;
    projectService.updateProjectSettings = async (_ref, next) => {
      settings = next as Record<string, unknown>;
      return settings as never;
    };
    tenantRuntimeService.applyAuthConfig = async () => ({} as never);

    const response = await rawAuthRequest("/v1/projects/tenant-a/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        experimental: {
          providers_with_own_linking_domain: ["github", "google"],
          provider_linking_domains: { github: "social" },
        },
      }),
    });
    const experimental = (settings.auth as { experimental: Record<string, unknown> }).experimental;

    expect(response.status).toBe(200);
    expect(experimental).toEqual({
      provider_linking_domains: { github: "social", google: "google" },
    });
    expect(experimental.providers_with_own_linking_domain).toBeUndefined();
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

  test("project settings expose only public asymmetric JWK material", async () => {
    config.authRuntimeOwnerRef = "";
    projectService.getProjectSettings = async () => ({
      auth: {
        jwt_secret: "stored-jwt-secret",
        oauth_server: {
          enabled: true,
          jwt_keys: [{
            kty: "EC",
            crv: "P-256",
            x: "public-x",
            y: "public-y",
            d: "private-d",
            kid: "ec-key",
            alg: "ES256",
            use: "sig",
            key_ops: ["sign"],
          }],
          jwt_jwks: {
            keys: [
              {
                kty: "EC",
                crv: "P-256",
                x: "public-x",
                y: "public-y",
                kid: "ec-key",
                alg: "ES256",
                use: "sig",
              },
              {
                kty: "oct",
                k: "symmetric-signing-secret",
                kid: "legacy-key",
                alg: "HS256",
                use: "sig",
              },
            ],
          },
        },
      },
      api_domain: "tenant-a.api.example.com",
    } as never);

    const response = await request("/v1/projects/tenant-a/settings");
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(serialized).not.toContain("stored-jwt-secret");
    expect(serialized).not.toContain("private-d");
    expect(serialized).not.toContain("symmetric-signing-secret");
    expect(body.auth.jwt_secret).toBe("********");
    expect(body.auth.oauth_server.jwt_keys).toEqual([{
      kty: "EC",
      crv: "P-256",
      x: "public-x",
      y: "public-y",
      kid: "ec-key",
      alg: "ES256",
      use: "sig",
    }]);
    expect(body.auth.oauth_server.jwt_jwks.keys).toEqual([{
      kty: "EC",
      crv: "P-256",
      x: "public-x",
      y: "public-y",
      kid: "ec-key",
      alg: "ES256",
      use: "sig",
    }]);
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
