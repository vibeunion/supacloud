// @supacloud-test-isolate
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteSystemdEnvValue } from "../../src/utils/systemd-env";
import {
  buildPostgresUri,
  buildTenantPsqlInvocation,
  quoteTomlBasicString,
  renderSystemdEnvLine,
  renderGoTrueAuthEnv,
  renderGoTruePasskeyEnv,
  renderGoTrueProviderLinkingEnv,
  renderGoTrueSamlEnv,
  renderGoTrueSessionPolicyEnv,
  renderPostgrestDbSchemas,
  renderTenantInternalRuntimeEnv,
} from "../../src/services/tenant-runtime-config";
import {
  canonicalAuthProviderLinkingConfig,
  normalizedProviderLinkingDomains,
} from "../../src/utils/provider-linking";
import {
  applyAuthSessionPolicyPatch,
  normalizeAuthSessionPolicyPatch,
  readAuthSessionPolicy,
} from "../../src/services/auth-session-policy";
import { authConfigChangesPostgrestVerifier } from "../../src/services/auth-runtime-impact";
import { isGoTruePasskeyVersionSupported, resolveTenantAuthUrlSettings } from "../../src/services/tenant-runtime.service";

describe("TenantRuntimeService safe config serialization", () => {
  const special = `p@:/#?% space '\"\\`;

  test("percent-encodes database credentials without changing the secret passed to psql", () => {
    expect(buildPostgresUri({
      protocol: "postgresql",
      user: special,
      password: special,
      host: "127.0.0.1",
      port: "6432",
      database: "supa test",
    })).toBe(
      "postgresql://p%40%3A%2F%23%3F%25%20space%20%27%22%5C:p%40%3A%2F%23%3F%25%20space%20%27%22%5C@127.0.0.1:6432/supa%20test",
    );

    const invocation = buildTenantPsqlInvocation({
      user: "postgres",
      password: special,
      host: "127.0.0.1",
      port: "6432",
      database: "supa test",
    }, ["-Atqc", "SELECT 1"]);
    expect(invocation.cmd).toEqual([
      "psql", "-h", "127.0.0.1", "-p", "6432", "-U", "postgres", "-d", "supa test", "-Atqc", "SELECT 1",
    ]);
    expect(invocation.cmd.join(" ")).not.toContain(special);
    expect(invocation.env).toEqual({ PGPASSWORD: special });
  });

  test("quotes EnvironmentFile and TOML values without assignment injection", () => {
    expect(renderSystemdEnvLine("SECRET", special)).toBe(`SECRET="p@:/#?% space '\\\"\\\\"`);
    expect(quoteTomlBasicString(special)).toBe(`"p@:/#?% space '\\\"\\\\"`);
  });

  test.each(["bad\nINJECTED=value", "bad\rINJECTED=value", "bad\0INJECTED=value"])(
    "rejects CR, LF, and NUL in every config serializer (%j)",
    (value) => {
      expect(() => renderSystemdEnvLine("SECRET", value)).toThrow(/control character/i);
      expect(() => quoteTomlBasicString(value)).toThrow(/control character/i);
      expect(() => buildPostgresUri({
        protocol: "postgres",
        user: "postgres",
        password: value,
        host: "127.0.0.1",
        port: "6432",
        database: "postgres",
      })).toThrow(/control character/i);
      expect(() => buildTenantPsqlInvocation({
        user: "postgres",
        password: value,
        host: "127.0.0.1",
        port: "6432",
        database: "postgres",
      }, [])).toThrow(/control character/i);
    },
  );
});

describe("TenantRuntimeService systemd env quoting", () => {
  test("single-quotes JSON values so systemd preserves double quotes", () => {
    expect(quoteSystemdEnvValue('[{"kty":"EC","d":"abc"}]')).toBe("'[{\"kty\":\"EC\",\"d\":\"abc\"}]'");
  });

  test("keeps non-JSON values double-quoted with systemd escapes", () => {
    expect(quoteSystemdEnvValue("line1\nline2\tC:\\keys")).toBe('"line1\\nline2\\tC:\\\\keys"');
  });

  test("double-quotes and escapes values containing both single and double quotes", () => {
    expect(quoteSystemdEnvValue(`{"name":"can't"}`)).toBe(`"{\\"name\\":\\"can't\\"}"`);
  });

  test.each(["bad\rINJECTED=value", "bad\0INJECTED=value"])(
    "rejects unsupported EnvironmentFile control characters (%j)",
    (value) => {
      expect(() => quoteSystemdEnvValue(value)).toThrow(/control character/i);
    },
  );
});

describe("TenantRuntimeService PostgREST schema rendering", () => {
  test("does not expose pgmq_public by default", () => {
    expect(renderPostgrestDbSchemas()).toBe("public, storage, graphql_public");
  });

  test("exposes pgmq_public only when the wrapper schema exists", () => {
    expect(renderPostgrestDbSchemas(true)).toBe("public, storage, graphql_public, pgmq_public");
  });

  test("appends validated project-owned schemas after platform schemas", () => {
    expect(renderPostgrestDbSchemas(false, ["api", "rpc"])).toBe(
      "public, storage, graphql_public, api, rpc",
    );
    expect(renderPostgrestDbSchemas(true, ["api"])).toBe(
      "public, storage, graphql_public, pgmq_public, api",
    );
  });

  test("renders tenant-local internal runtime env for Edge Functions", () => {
    expect(renderTenantInternalRuntimeEnv(3272, 4272)).toBe([
      "SUPACLOUD_INTERNAL_POSTGREST_PORT=3272",
      "SUPACLOUD_INTERNAL_GOTRUE_PORT=4272",
      "SUPACLOUD_INTERNAL_REST_URL=http://127.0.0.1:3272",
    ].join("\n"));
  });
});

describe("TenantRuntimeService GoTrue auth env rendering", () => {
  test("keeps an explicitly cleared canonical allowlist ahead of legacy redirects", () => {
    const settings = resolveTenantAuthUrlSettings("project-a", {
      auth: {
        uri_allow_list: "",
        URI_ALLOW_LIST: "https://uppercase-legacy.example.com/callback",
      },
      additional_redirect_urls: ["https://legacy.example.com/callback"],
    });

    expect(settings.uriAllowList).toBe("");
  });

  test("uses current session-policy defaults and official GoTrue env names", () => {
    // Names are verified against supabase/auth v2.193.0 configuration.go.
    const env = renderGoTrueSessionPolicyEnv({});
    expect(env).toBe([
      "GOTRUE_JWT_EXP=3600",
      "GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true",
      "GOTRUE_PASSWORD_MIN_LENGTH=8",
      "GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true",
      "GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10",
      "GOTRUE_SESSIONS_SINGLE_PER_USER=false",
    ].join("\n"));
    expect(env).not.toContain("GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_REUSE_INTERVAL");
    expect(env).not.toContain("GOTRUE_SESSIONS_INACTIVITY_TIMEOUT");
    expect(env).not.toContain("GOTRUE_SESSIONS_TIMEBOX");
    expect(env).not.toContain("GOTRUE_PASSWORD_REQUIRED_CHARACTERS");
  });

  test("renders GOTRUE_PASSWORD_REQUIRED_CHARACTERS with systemd-safe quoting", () => {
    const env = renderGoTrueSessionPolicyEnv({
      password_required_characters: "lower:upper:!@#$%",
    });
    expect(env).toContain('GOTRUE_PASSWORD_REQUIRED_CHARACTERS="lower:upper:!@#$%"');

    // 冒号转义与空格值必须原样传入 GoTrue 的 Decode 契约
    const escaped = renderGoTrueSessionPolicyEnv({
      password_required_characters: "abc\\:def:xy z",
    });
    expect(escaped).toContain('GOTRUE_PASSWORD_REQUIRED_CHARACTERS="abc\\\\:def:xy z"');
  });

  test("maps canonical policy fields and compatibility aliases into GoTrue env", () => {
    expect(renderGoTrueSessionPolicyEnv({
      jwt_exp: 7200,
      security_refresh_token_rotation_enabled: false,
      security_refresh_token_rotation_reuse_interval: 0,
      security_update_password_require_reauthentication: false,
      password_min_length: 12,
      sessions_inactivity_timeout: "30m",
      sessions_single_per_user: true,
      sessions_timebox: 86_400,
    })).toBe([
      "GOTRUE_JWT_EXP=7200",
      "GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=false",
      "GOTRUE_PASSWORD_MIN_LENGTH=12",
      "GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=false",
      "GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=0",
      "GOTRUE_SESSIONS_SINGLE_PER_USER=true",
      "GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=1800s",
      "GOTRUE_SESSIONS_TIMEBOX=86400s",
    ].join("\n"));
  });

  test("canonicalizes aliases, resets nullable values, and rejects invalid policy input", () => {
    const patch = normalizeAuthSessionPolicyPatch({
      jwt_exp: 5400,
      security_refresh_token_rotation_reuse_interval: 15,
      sessions_timebox: "1h30m",
      sessions_inactivity_timeout: 0,
    });
    const auth = applyAuthSessionPolicyPatch({
      jwt_exp: 3600,
      security_refresh_token_rotation_reuse_interval: 10,
      sessions_inactivity_timeout: 600,
    }, patch);

    expect(auth).toEqual({
      jwt_expiry: 5400,
      security_refresh_token_reuse_interval: 15,
      sessions_timebox: 5400,
    });
    expect(readAuthSessionPolicy(auth)).toMatchObject({
      jwt_expiry: 5400,
      security_refresh_token_reuse_interval: 15,
      sessions_inactivity_timeout: null,
      sessions_timebox: 5400,
    });
    expect(readAuthSessionPolicy({
      jwt_expiry: 3600,
      jwt_exp: "malformed-legacy-value",
    }).jwt_expiry).toBe(3600);
    expect(() => normalizeAuthSessionPolicyPatch({ password_min_length: 5 }))
      .toThrow(/password_min_length.*between 6 and 32767/);
    expect(() => normalizeAuthSessionPolicyPatch({ sessions_timebox: "tomorrow" }))
      .toThrow(/sessions_timebox.*Go duration/);
    expect(() => normalizeAuthSessionPolicyPatch({
      jwt_expiry: 3600,
      jwt_exp: 7200,
    })).toThrow(/conflicting values/);
  });

  test("validates password_required_characters and round-trips through the stored config", () => {
    const patch = normalizeAuthSessionPolicyPatch({
      password_required_characters: "lower:upper:digits",
    });
    const auth = applyAuthSessionPolicyPatch({ password_required_characters: "digits" }, patch);
    expect(auth).toEqual({ password_required_characters: "lower:upper:digits" });
    expect(readAuthSessionPolicy(auth).password_required_characters).toBe("lower:upper:digits");

    // null 与空字符串都恢复为无要求
    const reset = applyAuthSessionPolicyPatch(auth, normalizeAuthSessionPolicyPatch({
      password_required_characters: null,
    }));
    expect(readAuthSessionPolicy(reset).password_required_characters).toBe("");
    const emptied = applyAuthSessionPolicyPatch(auth, normalizeAuthSessionPolicyPatch({
      password_required_characters: "",
    }));
    expect(readAuthSessionPolicy(emptied).password_required_characters).toBe("");

    expect(() => normalizeAuthSessionPolicyPatch({ password_required_characters: 42 }))
      .toThrow(/password_required_characters.*string or null/);
    expect(readAuthSessionPolicy({ password_required_characters: "::" }).password_required_characters)
      .toBe("::");
    expect(readAuthSessionPolicy({ password_required_characters: "x".repeat(200) }).password_required_characters)
      .toBe("x".repeat(200));
    expect(() => normalizeAuthSessionPolicyPatch({ password_required_characters: "ab\ncd" }))
      .toThrow(/password_required_characters.*control character/);
  });

  test("defaults phone signup off when no managed SMS provider is configured", () => {
    expect(renderGoTrueAuthEnv({})).toBe([
      "GOTRUE_DISABLE_SIGNUP=false",
      "GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true",
      "GOTRUE_EXTERNAL_EMAIL_ENABLED=true",
      "GOTRUE_EXTERNAL_PHONE_ENABLED=false",
    ].join("\n"));
  });

  test("maps disable_signup and external auth switches into GoTrue env values", () => {
    expect(renderGoTrueAuthEnv({
      disable_signup: true,
      external_anonymous_users_enabled: false,
      external_email_enabled: false,
      external_phone_enabled: true,
    })).toBe([
      "GOTRUE_DISABLE_SIGNUP=true",
      "GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false",
      "GOTRUE_EXTERNAL_EMAIL_ENABLED=false",
      "GOTRUE_EXTERNAL_PHONE_ENABLED=true",
    ].join("\n"));
  });

  test("treats enable_signup=false as signup disabled even when disable_signup is absent", () => {
    expect(renderGoTrueAuthEnv({
      enable_signup: false,
    })).toContain("GOTRUE_DISABLE_SIGNUP=true");
  });

  test("maps auth email templates into quoted GoTrue mailer env values", () => {
    expect(renderGoTrueAuthEnv({
      mailer_subjects_confirmation: "欢迎确认",
      mailer_templates_confirmation_content: `<p>Hi {{ .Email }}</p><a href="{{ .ConfirmationURL }}">Confirm</a>`,
      MAILER_SUBJECTS_RECOVERY: "Reset your password",
    })).toContain([
      "GOTRUE_MAILER_SUBJECTS_CONFIRMATION=\"欢迎确认\"",
      "GOTRUE_MAILER_TEMPLATES_CONFIRMATION_CONTENT='<p>Hi {{ .Email }}</p><a href=\"{{ .ConfirmationURL }}\">Confirm</a>'",
      "GOTRUE_MAILER_SUBJECTS_RECOVERY=\"Reset your password\"",
    ].join("\n"));
  });

  test("preserves multiline email templates in a systemd-compatible value", () => {
    expect(renderGoTrueAuthEnv({
      mailer_templates_confirmation_content: `<p>Hi {{ .Email }}</p>
<a href="{{ .ConfirmationURL }}">Confirm</a>`,
    })).toContain([
      "GOTRUE_MAILER_TEMPLATES_CONFIRMATION_CONTENT='<p>Hi {{ .Email }}</p>",
      '<a href="{{ .ConfirmationURL }}">Confirm</a>\'',
    ].join("\n"));
  });

  test("keeps provider linking opt-in disabled and renders a sorted canonical map", () => {
    expect(renderGoTrueProviderLinkingEnv({})).toBe("");
    expect(renderGoTrueProviderLinkingEnv({ experimental: { provider_linking_domains: {} } })).toBe("");
    expect(renderGoTrueProviderLinkingEnv({
      experimental: {
        provider_linking_domains: {
          "custom:google": "social",
          "custom:github": "social",
        },
      },
    })).toBe(
      'GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS="custom:github=social,custom:google=social"',
    );
  });

  test("normalizes the deprecated provider list without rendering its legacy env name", () => {
    const canonical = canonicalAuthProviderLinkingConfig({
      experimental: {
        providers_with_own_linking_domain: ["github", "github", "custom:google"],
        provider_linking_domains: { github: "social" },
      },
    });
    expect(canonical).toEqual({
      experimental: {
        provider_linking_domains: {
          "custom:google": "custom:google",
          github: "social",
        },
      },
    });
    const rendered = renderGoTrueProviderLinkingEnv(canonical);
    expect(rendered).not.toContain("PROVIDERS_WITH_OWN_LINKING_DOMAIN");
    expect(() => renderGoTrueProviderLinkingEnv({
      experimental: { providers_with_own_linking_domain: ["github"] },
    })).toThrow(/must be migrated before runtime rendering/);
  });

  test.each([
    [{ "": "social" }, /non-empty/],
    [{ github: "" }, /non-empty/],
    [{ "github,google": "social" }, /only letters/],
    [{ github: "social=shared" }, /only letters/],
    [{ " github ": "social", github: "default" }, /Duplicate/],
    [{ github: "social\nGOTRUE_OPERATOR_TOKEN=stolen" }, /only letters/],
  ])("rejects ambiguous or injectable provider linking maps", (providerMap, errorPattern) => {
    expect(() => normalizedProviderLinkingDomains({ provider_linking_domains: providerMap }))
      .toThrow(errorPattern);
  });

  test("rejects newline injection through email and SAML settings", () => {
    expect(() => renderGoTrueAuthEnv({
      mailer_subjects_confirmation: "safe\nGOTRUE_OPERATOR_TOKEN=stolen",
    })).toThrow(/control character/i);
    expect(() => renderGoTrueSamlEnv({
      saml: { enabled: true, private_key: "safe\0INJECTED=value" },
    })).toThrow(/control character/i);
  });

  test("wires Passkey and WebAuthn runtime variables into the managed GoTrue service", () => {
    const configSource = readFileSync(
      join(import.meta.dir, "../../src/services/tenant-runtime-config.ts"),
      "utf8",
    );
    const runtimeSource = readFileSync(
      join(import.meta.dir, "../../src/services/tenant-runtime.service.ts"),
      "utf8",
    );
    const runtimeImplementation = `${configSource}\n${runtimeSource}`;

    expect(runtimeImplementation).toContain("renderGoTruePasskeyEnv");
    expect(runtimeImplementation).toContain("GOTRUE_PASSKEY_");
    expect(runtimeImplementation).toContain("GOTRUE_WEBAUTHN_");
  });

  test("renders the official GoTrue Passkey configuration shape", () => {
    expect(renderGoTruePasskeyEnv({
      passkey_enabled: true,
      passkey_max_passkeys_per_user: 6,
      webauthn_rp_id: "example.com",
      webauthn_rp_display_name: "Example App",
      webauthn_rp_origins: ["https://example.com", "https://app.example.com"],
    })).toBe([
      "GOTRUE_PASSKEY_ENABLED=true",
      "GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER=6",
      'GOTRUE_WEBAUTHN_RP_ID="example.com"',
      'GOTRUE_WEBAUTHN_RP_DISPLAY_NAME="Example App"',
      'GOTRUE_WEBAUTHN_RP_ORIGINS="https://example.com,https://app.example.com"',
    ].join("\n"));
  });

  test.each([
    [{ passkey_enabled: true, webauthn_rp_id: "https://example.com", webauthn_rp_display_name: "Example", webauthn_rp_origins: ["https://example.com"] }, /bare domain/],
    [{ passkey_enabled: true, webauthn_rp_id: "example.com", webauthn_rp_display_name: "Example", webauthn_rp_origins: ["http://example.com"] }, /HTTPS/],
    [{ passkey_enabled: true, webauthn_rp_id: "example.com", webauthn_rp_display_name: "Example", webauthn_rp_origins: ["https://other.example"] }, /match or be a subdomain/],
    [{ passkey_enabled: true, webauthn_rp_id: "example.com", webauthn_rp_display_name: "Example", webauthn_rp_origins: ["https://example.com", "https://a.example.com", "https://b.example.com", "https://c.example.com", "https://d.example.com", "https://e.example.com"] }, /at most 5/],
  ])("rejects invalid Passkey relying-party configuration", (authConfig, errorPattern) => {
    expect(() => renderGoTruePasskeyEnv(authConfig)).toThrow(errorPattern);
  });

  test("accepts the official comma-separated Management API origin format", () => {
    expect(renderGoTruePasskeyEnv({
      passkey_enabled: true,
      webauthn_rp_id: "localhost",
      webauthn_rp_display_name: "Local",
      webauthn_rp_origins: "http://localhost:3000,http://localhost:5173",
    })).toContain('GOTRUE_WEBAUTHN_RP_ORIGINS="http://localhost:3000,http://localhost:5173"');
  });

  test("requires a GoTrue version that includes the stock Passkey routes", () => {
    expect(isGoTruePasskeyVersionSupported("v2.193.1")).toBe(false);
    expect(isGoTruePasskeyVersionSupported("v2.194.0")).toBe(true);
    expect(isGoTruePasskeyVersionSupported("v2.194.0+supacloud")).toBe(true);
    expect(isGoTruePasskeyVersionSupported("v3.0.0")).toBe(false);
    expect(isGoTruePasskeyVersionSupported("gotrue dev")).toBe(false);
  });

  test("maps SAML SP key rotation config into GoTrue env values", () => {
    expect(renderGoTrueSamlEnv({
      saml: {
        enabled: true,
        private_key: "current-key",
        private_key_next: "next-key",
        external_url: "https://login.example.com/auth/v1",
        allow_encrypted_assertions: true,
        relay_state_validity_period: "5m",
        rate_limit_assertion: 20,
      },
    })).toBe([
      "GOTRUE_SAML_ENABLED=true",
      'GOTRUE_SAML_PRIVATE_KEY="current-key"',
      'GOTRUE_SAML_PRIVATE_KEY_NEXT="next-key"',
      'GOTRUE_SAML_EXTERNAL_URL="https://login.example.com/auth/v1"',
      "GOTRUE_SAML_ALLOW_ENCRYPTED_ASSERTIONS=true",
      'GOTRUE_SAML_RELAY_STATE_VALIDITY_PERIOD="5m"',
      "GOTRUE_SAML_RATE_LIMIT_ASSERTION=20",
    ].join("\n"));
  });
});

describe("Auth config PostgREST verifier impact", () => {
  test("keeps session and GoTrue-only OAuth settings on the GoTrue apply path", () => {
    expect(authConfigChangesPostgrestVerifier(
      { jwt_expiry: 3600, oauth_server: { authorization_path: "/old" } },
      { jwt_expiry: 7200, oauth_server: { authorization_path: "/new" } },
    )).toBe(false);
    expect(authConfigChangesPostgrestVerifier(
      { third_party_auth: { auth_endpoint_mode: "external", auth_upstream: "https://old.example.com" } },
      { third_party_auth: { auth_endpoint_mode: "local", auth_upstream: "http://127.0.0.1:9999" } },
    )).toBe(false);
  });

  test.each([
    ["enabled state", { enabled: false }, { enabled: true }],
    ["issuer", { issuer: "https://old.example.com/auth/v1" }, { issuer: "https://new.example.com/auth/v1" }],
    ["signing algorithm", { signing_alg: "ES256" }, { signing_alg: "RS256" }],
    ["signing keys", { jwt_keys: [{ kid: "old" }] }, { jwt_keys: [{ kid: "new" }] }],
    ["verification JWKS", { jwt_jwks: { keys: [{ kid: "old" }] } }, { jwt_jwks: { keys: [{ kid: "new" }] } }],
  ])("detects OAuth server %s changes", (_label, previousOauth, nextOauth) => {
    expect(authConfigChangesPostgrestVerifier(
      { oauth_server: previousOauth },
      { oauth_server: nextOauth },
    )).toBe(true);
  });

  test("detects third-party verifier policy changes after compatibility normalization", () => {
    expect(authConfigChangesPostgrestVerifier(
      { third_party_auth: { enabled: true, issuer: "https://issuer.example.com", audience: "old", client_id: "client", jwtJwks: { keys: [{ kid: "one" }] } } },
      { third_party_auth: { enabled: true, issuer: "https://issuer.example.com", audience: ["new"], client_id: "client", jwt_jwks: { keys: [{ kid: "one" }] } } },
    )).toBe(true);
  });

  test("ignores object key ordering in equivalent verifier material", () => {
    expect(authConfigChangesPostgrestVerifier(
      { oauth_server: { jwt_jwks: { keys: [{ kty: "EC", kid: "same", alg: "ES256" }] } } },
      { oauth_server: { jwt_jwks: { keys: [{ alg: "ES256", kid: "same", kty: "EC" }] } } },
    )).toBe(false);
  });
});

describe("TenantRuntimeService auth-only apply boundary", () => {
  test("uses checked GoTrue calls and attested PostgREST refreshes in the auth apply path", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/services/tenant-runtime.service.ts"),
      "utf8",
    );
    const restartSection = source.slice(
      source.indexOf("public async restartRuntime"),
      source.indexOf("private async applyGotrueAuthConfig"),
    );
    const authApplySection = source.slice(
      source.indexOf("private async applyGotrueAuthConfig"),
      source.indexOf("private async refreshSharedAuthDependents"),
    );

    expect(restartSection).not.toContain("runSystemctlOrThrow");
    expect(authApplySection).toContain('runSystemctlOrThrow("restart", unit)');
    expect(authApplySection).toContain('runSystemctlOrThrow("start", unit)');
    expect(authApplySection).toContain(
      'activatePostgrestGeneration(ref, "refresh-if-running")',
    );
    expect(authApplySection).toContain('installSystemdTemplate("checked")');
  });

  test("uses attested activation and serializes PostgREST pool config changes", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/services/tenant-runtime.service.ts"),
      "utf8",
    );
    const poolUpdateSection = source.slice(
      source.indexOf("private postgrestPoolOperations"),
      source.indexOf("private async refreshProjectPostgrestVerifier"),
    );

    expect(poolUpdateSection).toContain("restartAndAttest");
    expect(poolUpdateSection).toContain("startOrRestartPostgrestGeneration");
    expect(poolUpdateSection).toContain("withTenantConfigLock");
    expect(source).toContain("generateTenantConfigUnlocked");
  });

  test("renders a bounded GoTrue database pool", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/services/tenant-runtime.service.ts"),
      "utf8",
    );
    const gotrueEnvStart = source.indexOf("const gotrueEnvLines = [");
    const gotrueEnvSection = source.slice(
      gotrueEnvStart,
      source.indexOf("const oauthServerConfig = normalizeOAuthServerConfig", gotrueEnvStart),
    );

    expect(gotrueEnvSection).toContain("GOTRUE_DB_DATABASE_URL");
    expect(gotrueEnvSection).toContain("GOTRUE_DB_MAX_POOL_SIZE");
    expect(gotrueEnvSection).toContain("config.gotrueDbPool");
  });

  test("prevents overlapping runtime reconciliation runs", () => {
    const workerSource = readFileSync(
      join(import.meta.dir, "../../src/workers/runtime-reconcile.worker.ts"),
      "utf8",
    );

    expect(workerSource).toContain("if (reconciliationInFlight) return reconciliationInFlight");
    expect(workerSource).toContain("performRuntimeReconciliation().finally");
  });
});
