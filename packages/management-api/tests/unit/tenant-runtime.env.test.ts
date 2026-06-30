import { describe, expect, test } from "bun:test";
import { quoteSystemdEnvValue } from "../../src/utils/systemd-env";
import {
  renderGoTrueAuthEnv,
  renderGoTruePasskeyEnv,
  renderGoTrueSamlEnv,
  renderPostgrestDbSchemas,
  renderTenantInternalRuntimeEnv,
} from "../../src/services/tenant-runtime.service";

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
});

describe("TenantRuntimeService PostgREST schema rendering", () => {
  test("does not expose pgmq_public by default", () => {
    expect(renderPostgrestDbSchemas()).toBe("public, storage, graphql_public");
  });

  test("exposes pgmq_public only when the wrapper schema exists", () => {
    expect(renderPostgrestDbSchemas(true)).toBe("public, storage, graphql_public, pgmq_public");
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
  test("defaults signup-related runtime flags to the current permissive behavior", () => {
    expect(renderGoTrueAuthEnv({})).toBe([
      "GOTRUE_DISABLE_SIGNUP=false",
      "GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true",
      "GOTRUE_EXTERNAL_EMAIL_ENABLED=true",
      "GOTRUE_EXTERNAL_PHONE_ENABLED=true",
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
      mailer_templates_confirmation_content: `<p>Hi {{ .Email }}</p>\n<a href="{{ .ConfirmationURL }}">Confirm</a>`,
      MAILER_SUBJECTS_RECOVERY: "Reset your password",
    })).toContain([
      "GOTRUE_MAILER_SUBJECTS_CONFIRMATION=\"欢迎确认\"",
      "GOTRUE_MAILER_TEMPLATES_CONFIRMATION_CONTENT='<p>Hi {{ .Email }}</p>",
      "<a href=\"{{ .ConfirmationURL }}\">Confirm</a>'",
      "GOTRUE_MAILER_SUBJECTS_RECOVERY=\"Reset your password\"",
    ].join("\n"));
  });

  test("maps passkey and WebAuthn config into GoTrue env values only when enabled", () => {
    expect(renderGoTruePasskeyEnv({}, {
      rpId: "example.com",
      rpDisplayName: "SupaCloud",
      rpOrigins: ["https://example.com"],
    })).toBe("");

    expect(renderGoTruePasskeyEnv({
      passkey: { enabled: true, max_passkeys_per_user: 7 },
      webauthn: {
        rp_id: "login.example.com",
        rp_display_name: "Example Login",
        rp_origins: ["https://login.example.com", "https://app.example.com"],
      },
      mfa: { webauthn: { enroll_enabled: true, verify_enabled: true } },
    }, {
      rpId: "example.com",
      rpDisplayName: "SupaCloud",
      rpOrigins: ["https://example.com"],
    })).toBe([
      "GOTRUE_PASSKEY_ENABLED=true",
      "GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER=7",
      "GOTRUE_MFA_WEBAUTHN_ENROLL_ENABLED=true",
      "GOTRUE_MFA_WEBAUTHN_VERIFY_ENABLED=true",
      "GOTRUE_WEBAUTHN_RP_ID=login.example.com",
      'GOTRUE_WEBAUTHN_RP_DISPLAY_NAME="Example Login"',
      "GOTRUE_WEBAUTHN_RP_ORIGINS=https://login.example.com,https://app.example.com",
      "GOTRUE_WEBAUTHN_CHALLENGE_EXPIRY_DURATION=5m",
    ].join("\n"));
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
      "GOTRUE_SAML_EXTERNAL_URL=https://login.example.com/auth/v1",
      "GOTRUE_SAML_ALLOW_ENCRYPTED_ASSERTIONS=true",
      "GOTRUE_SAML_RELAY_STATE_VALIDITY_PERIOD=5m",
      "GOTRUE_SAML_RATE_LIMIT_ASSERTION=20",
    ].join("\n"));
  });
});
