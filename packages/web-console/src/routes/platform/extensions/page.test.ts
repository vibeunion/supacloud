import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("platform extensions SVAdmin migration", () => {
  test("uses the latest custom mutation hook for install and remove", () => {
    expect(source).toContain("useCustomMutation");
    expect(source).toContain('url: `${extensionsResource}/${action}`');
    expect(source).toContain('method: "post"');
    expect(source).toContain("invalidates: [\"list\"]");
    expect(source).not.toContain("createMutation");
    expect(source).not.toContain("apiClient");
  });
});
