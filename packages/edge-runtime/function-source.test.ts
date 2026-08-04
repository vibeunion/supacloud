import { describe, expect, test } from "bun:test";
import path from "path";
import {
  activeFunctionPathCandidates,
  BUNDLED_SOURCE_RUNTIME_ENTRY,
  functionPathCandidates,
} from "./function-source";

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

  test("falls back from a configured version only to frozen legacy aliases", () => {
    expect(activeFunctionPathCandidates("/functions/project", "supauth", "7")).toEqual([
      path.join("/functions/project", ".versions", "supauth", "7", "src", BUNDLED_SOURCE_RUNTIME_ENTRY),
      "/functions/project/.versions/supauth/7/index.js",
      path.join("/functions/project", ".src-supauth", BUNDLED_SOURCE_RUNTIME_ENTRY),
      "/functions/project/supauth.js",
      "/functions/project/supauth.ts",
    ]);
  });

  test("uses mutable aliases only for a legacy activation without a version", () => {
    expect(activeFunctionPathCandidates("/functions/project", "supauth", null)).toEqual([
      path.join("/functions/project", ".src-supauth", BUNDLED_SOURCE_RUNTIME_ENTRY),
      "/functions/project/supauth.js",
      "/functions/project/supauth.ts",
    ]);
  });
});
