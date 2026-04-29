import { describe, expect, test } from "bun:test";
import { isMaskedSecretValue, stripMaskedSecretValues } from "./tenant-env";

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
});
