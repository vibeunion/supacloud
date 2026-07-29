import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("RLS policy labels", () => {
  test("localizes known command and policy-type labels without changing raw values", () => {
    expect(source).toContain("policyActionLabel(policy.cmd)");
    expect(source).toContain("title={policy.cmd}");
    expect(source).toContain("policyTypeLabel(policy.permissive)");
    expect(source).toContain("title={policy.permissive}");
  });
});
