import { describe, expect, test } from "bun:test";
import path from "path";
import {
  activeFunctionPathCandidates,
  attestedFunctionArtifactPath,
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

  test("uses only immutable artifacts for a configured version", () => {
    expect(activeFunctionPathCandidates("/functions/project", "supauth", "7")).toEqual([
      path.join("/functions/project", ".versions", "supauth", "7", "src", BUNDLED_SOURCE_RUNTIME_ENTRY),
      "/functions/project/.versions/supauth/7/index.js",
    ]);
  });

  test("keeps a legacy zero activation bound to its immutable artifact", () => {
    expect(activeFunctionPathCandidates("/functions/project", "supauth", "0")).toEqual([
      path.join("/functions/project", ".versions", "supauth", "0", "src", BUNDLED_SOURCE_RUNTIME_ENTRY),
      "/functions/project/.versions/supauth/0/index.js",
    ]);
  });

  test("uses mutable aliases only for a legacy activation without a version", () => {
    expect(activeFunctionPathCandidates("/functions/project", "supauth", null)).toEqual([
      path.join("/functions/project", ".src-supauth", BUNDLED_SOURCE_RUNTIME_ENTRY),
      "/functions/project/supauth.js",
      "/functions/project/supauth.ts",
    ]);
  });

  test("uses the immutable source runtime entry after validating the authority digest", () => {
    expect(attestedFunctionArtifactPath(
      "/functions/project",
      "supauth",
      "7",
      "a".repeat(64),
    )).toBe("/functions/project/.versions/supauth/7/src/.supacloud-entry.js");
    expect(() => attestedFunctionArtifactPath(
      "/functions/project",
      "supauth",
      "7",
      "a".repeat(63),
    )).toThrow("Function activation artifact digest is invalid");
  });
});
