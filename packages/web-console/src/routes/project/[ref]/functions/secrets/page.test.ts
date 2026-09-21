import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("function secrets SVAdmin migration", () => {
  test("uses the latest custom mutation hooks for secret writes", () => {
    expect(source).toContain("useCustomMutation");
    expect(source).toContain('method: "post"');
    expect(source).toContain('method: "delete"');
    expect(source).toContain("invalidates: [\"list\"]");
    expect(source).not.toContain("createMutation");
    expect(source).not.toContain("apiClient");
  });

  test("keeps secret values out of the list renderer", () => {
    expect(source).toContain("readSecrets(query.data as unknown)");
    expect(source).toContain("masked_value");
    expect(source).not.toContain("secret.value");
  });
});
