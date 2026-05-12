import { describe, expect, test } from "bun:test";
import { isMaskedSecretValue, normalizeTenantEnv, stripMaskedSecretValues } from "./tenant-env";

describe("tenant env masking guard", () => {
  test("recognizes masked secret placeholders", () => {
    expect(isMaskedSecretValue("********")).toBe(true);
    expect(isMaskedSecretValue("  ********  ")).toBe(true);
    expect(isMaskedSecretValue("real-value")).toBe(false);
  });

  test("drops masked placeholders before runtime injection", () => {
    expect(stripMaskedSecretValues({
      SUPABASE_URL: "********",
      SUPABASE_SERVICE_ROLE_KEY: "header.payload.signature",
    })).toEqual({
      SUPABASE_SERVICE_ROLE_KEY: "header.payload.signature",
    });
  });

  test("normalizes fallback tenant env with routing variables", () => {
    expect(normalizeTenantEnv("proj_1", {
      SUPABASE_URL: "https://api.example.com",
    })).toEqual(expect.objectContaining({
      SUPABASE_URL: "https://api.example.com",
      SUPACLOUD_PROJECT_REF: "proj_1",
      X_PROJECT_REF: "proj_1",
      SUPACLOUD_PROJECT_API_HOST: "api.example.com",
      SUPACLOUD_INTERNAL_SUPABASE_URL: "http://127.0.0.1",
      SUPACLOUD_INTERNAL_AUTH_URL: "http://127.0.0.1/auth/v1",
      SUPACLOUD_INTERNAL_REST_URL: "http://127.0.0.1/rest/v1",
    }));
  });
});
