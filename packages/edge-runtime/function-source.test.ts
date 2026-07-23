import { describe, expect, test } from "bun:test";
import path from "path";
import { BUNDLED_SOURCE_RUNTIME_ENTRY, functionPathCandidates } from "./function-source";

describe("multi-file function runtime source", () => {
  test("loads the active source-dir entry before the legacy bundle", () => {
    expect(functionPathCandidates("/functions/project", "supauth")).toEqual([
      path.join("/functions/project", ".src-supauth", BUNDLED_SOURCE_RUNTIME_ENTRY),
      "/functions/project/supauth.js",
      "/functions/project/supauth.ts",
    ]);
  });

  test("loads a requested version from its immutable source directory", () => {
    expect(functionPathCandidates("/functions/project", "supauth", "7")).toEqual([
      path.join("/functions/project", ".versions", "supauth", "7", "src", BUNDLED_SOURCE_RUNTIME_ENTRY),
      "/functions/project/.versions/supauth/7/index.js",
    ]);
  });
});
