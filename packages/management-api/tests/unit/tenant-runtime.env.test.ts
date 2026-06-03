import { describe, expect, test } from "bun:test";
import { quoteSystemdEnvValue } from "../../src/utils/systemd-env";
import { renderPostgrestDbSchemas } from "../../src/services/tenant-runtime.service";

describe("TenantRuntimeService systemd env quoting", () => {
  test("single-quotes JSON values so systemd preserves double quotes", () => {
    expect(quoteSystemdEnvValue('[{"kty":"EC","d":"abc"}]')).toBe("'[{\"kty\":\"EC\",\"d\":\"abc\"}]'");
  });

  test("keeps non-JSON values double-quoted with systemd escapes", () => {
    expect(quoteSystemdEnvValue("line1\nline2\tC:\\keys")).toBe('"line1\\nline2\\tC:\\\\keys"');
  });

  test("rejects values that cannot be represented safely in EnvironmentFile", () => {
    expect(() => quoteSystemdEnvValue(`{"name":"can't"}`)).toThrow("both single and double quotes");
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
