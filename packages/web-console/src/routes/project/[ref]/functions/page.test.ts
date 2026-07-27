import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("edge function JWT toggle", () => {
  test("renders the confirmed server state without mutating query records", () => {
    expect(source).toContain("requireVerifyJwtResponse(await res.json())");
    expect(source).toContain("functions = functions.map");
    expect(source).toContain("selectedFunction = { ...selectedFunction, verify_jwt: verifyJwt }");
    expect(source).not.toContain("fn.verify_jwt =");
  });

  test("prevents repeated updates while a toggle request is pending", () => {
    expect(source).toContain("disabled={verifyJwtMutation.isPending}");
    expect(source).toContain("aria-busy={jwtUpdatingSlug === fn.slug}");
  });
});
