import { expect, test } from "bun:test";
import { assertRegistryManifest, exactPublishedVersion } from "./check_published_customer";

test("published acceptance requires an immutable registry version", () => {
  expect(exactPublishedVersion("0.99.0")).toBe("0.99.0");
  for (const version of ["latest", "^0.99.0", "file:../cli", "../cli", "", undefined]) {
    expect(() => exactPublishedVersion(version)).toThrow("exact published version");
  }
});
test("consumer verification cannot fall back to workspace, tarballs or URLs", () => {
  assertRegistryManifest({ dependencies: { "@supacloud/app": "^0.1.0" } });
  for (const version of ["file:../app", "workspace:*", "link:../app", "https://host/package.tgz", "github:owner/repo"]) {
    expect(() => assertRegistryManifest({ overrides: { "@supacloud/app": version } })).toThrow();
  }
  expect(() => assertRegistryManifest({ overrides: { nested: { package: "1.0.0" } } })).toThrow();
});
