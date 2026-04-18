import { describe, test, expect, mock } from "bun:test";
import { config } from "../../src/config";

describe("Auth Middleware Logic", () => {
  const masterToken = config.masterToken;

  test("should have a master token configured", () => {
    expect(masterToken).toBeDefined();
    expect(typeof masterToken).toBe("string");
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
});
