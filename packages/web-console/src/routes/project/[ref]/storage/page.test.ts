import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("storage breadcrumb", () => {
  test("localizes the breadcrumb without translating bucket identifiers", () => {
    expect(source).toContain('$t("Storage.breadcrumb", { values: { bucket: selectedBucketId ?? "" } })');
    expect(source).toContain("selectedBucketId = String(bucket.id || bucket.name)");
  });

  test("adds a localized label around the default bucket name", () => {
    expect(source).toContain('bucketName === "bucket" ? $t("Storage.default_bucket") : bucketName');
    expect(source).toContain("title={bucket.name}");
  });
});
