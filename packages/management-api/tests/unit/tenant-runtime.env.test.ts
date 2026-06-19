import { describe, expect, test } from "bun:test";
import { quoteSystemdEnvValue } from "../../src/utils/systemd-env";
import { renderGoTrueAuthEnv, renderPostgrestDbSchemas } from "../../src/services/tenant-runtime.service";

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
});
