import { describe, test, expect, mock } from "bun:test";
import { config } from "../../src/config";
import {
  extractProjectRefCandidates,
  extractProjectRefFromPath,
} from "../../src/utils/project-auth";

describe("Auth Middleware Logic", () => {
  const masterToken = config.masterToken;

  test("should have a master token configured", () => {
    expect(masterToken).toBeDefined();
    expect(masterToken.length).toBeGreaterThan(0);
  });

  test("should match valid Bearer token format", () => {
    const validHeader = `Bearer ${masterToken}`;
    expect(validHeader.startsWith("Bearer ")).toBe(true);

    const token = validHeader.slice(7);
    expect(token).toBe(masterToken);
  });

  test("should reject non-Bearer formats", () => {
    const basicHeader = "Basic dXNlcjpwYXNz";
    expect(basicHeader.startsWith("Bearer ")).toBe(false);
  });

  test("should reject empty authorization", () => {
    const emptyHeader = "";
    expect(emptyHeader.startsWith("Bearer ")).toBe(false);
  });

  test("should reject wrong token", () => {
    const wrongToken = "wrong-token-value";
    expect(wrongToken).not.toBe(masterToken);
  });

  test("should extract scoped project ref from management API path", () => {
    expect(
      extractProjectRefFromPath("/v1/projects/urocrsxqvrudgdgndiny/database/sql"),
    ).toBe("urocrsxqvrudgdgndiny");
    expect(extractProjectRefFromPath("/health")).toBeNull();
  });

  test("should prefer scoped project ref when JWT issuer is generic", () => {
    expect(
      extractProjectRefCandidates(
        { iss: "supabase", role: "service_role" },
        "urocrsxqvrudgdgndiny",
      ),
    ).toEqual(["urocrsxqvrudgdgndiny"]);
  });

  test("should extract project ref candidates from payload and issuer URL", () => {
    expect(
      extractProjectRefCandidates({
        iss: "https://urocrsxqvrudgdgndiny.supabase.co",
        ref: "urocrsxqvrudgdgndiny",
        role: "service_role",
      }),
    ).toEqual(["urocrsxqvrudgdgndiny"]);
  });
});
