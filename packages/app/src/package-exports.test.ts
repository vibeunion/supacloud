import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as {
  type?: string;
  exports?: Record<string, Record<string, unknown>>;
  scripts?: Record<string, string>;
};

describe("package format", () => {
  test("publishes an ESM-only root entry", () => {
    expect(packageJson.type).toBe("module");
    expect(packageJson.exports?.["."]?.import).toBe("./dist/index.js");
    expect(packageJson.exports?.["."]?.require).toBeUndefined();
    expect(packageJson.scripts?.["build:js"]).not.toContain("format cjs");
    expect(packageJson.scripts?.["build:js"]).not.toContain(".cjs");
  });
});
