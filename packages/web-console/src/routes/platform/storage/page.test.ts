import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("platform storage status", () => {
  test("maps the storage-status contract instead of discarding its capacity fields", () => {
    expect(source).toContain("data.size");
    expect(source).toContain("data.used");
    expect(source).toContain('data.status === "mounted"');
  });

  test("shows the safe diagnostic returned for an unhealthy backend", () => {
    expect(source).toContain("storageDiagnostic()");
    expect(source).toContain("object_storage_http_error");
    expect(source).toContain("PlatformStorage.status_request_failed");
  });
});
