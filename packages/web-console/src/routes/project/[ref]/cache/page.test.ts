import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("project cache console", () => {
  test("uses the authenticated management API for exact-key operations", () => {
    expect(source).toContain('postCacheRequest("operations"');
    expect(source).toContain("/cache/${pathSuffix}");
    expect(source).toContain("apiClient(");
    expect(source).toContain('type CacheOperation = "get" | "set" | "delete" | "ttl" | "getset" | "getdel"');
    expect(source).not.toContain(":9010");
  });

  test("requires both typed and browser confirmation before flushing", () => {
    expect(source).toContain("confirmation !== projectRef");
    expect(source).toContain("window.confirm");
    expect(source).toContain('postCacheRequest("flush", { confirmation: projectRef })');
  });
});
