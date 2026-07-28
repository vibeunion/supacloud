import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("platform cache runtime console", () => {
  test("loads bounded status through the management API", () => {
    expect(source).toContain('apiClient("/v1/cache")');
    expect(source).toContain("status.activeTenants");
    expect(source).toContain("status.connectionsPerTenant");
    expect(source).not.toContain(":9010");
  });

  test("keeps platform queue and rate limiting ownership visible", () => {
    expect(source).toContain("Cache.queue_owner_desc");
    expect(source).toContain("Cache.rate_limit_owner_desc");
  });

  test("renders an expected empty state when the cache data plane is not configured", () => {
    expect(source).toContain("!status.configured");
    expect(source).toContain("Cache.not_configured_desc");
  });
});
