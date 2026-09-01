import { describe, expect, test } from "bun:test";
import {
  edgeFunctionActivationGenerationPath,
  parseEdgeFunctionActivationManifest,
} from "./function-activation";

const ACTIVATION_ID = "00000000-0000-4000-8000-000000000001";

describe("Edge Function activation generation paths", () => {
  test.each(["../escape", "nested/escape", "", "."])(
    "rejects the unsafe Function slug %j before resolving a path",
    (functionSlug) => {
      expect(() => edgeFunctionActivationGenerationPath(
        "/trusted/project",
        functionSlug,
        ACTIVATION_ID,
      )).toThrow("Invalid Function slug");
    },
  );
});

describe("Edge Function framework profiles", () => {
  test("defaults legacy manifests to fetch", () => {
    expect(parseEdgeFunctionActivationManifest('{"verify_jwt":true,"version":"1"}').config.framework)
      .toBe("fetch");
  });

  test("accepts first-class Fetch framework profiles", () => {
    for (const framework of ["fetch", "elysia", "hono", "sveltekit-function"]) {
      expect(parseEdgeFunctionActivationManifest(JSON.stringify({ framework })).config.framework)
        .toBe(framework);
    }
  });

  test("rejects unsupported framework profiles", () => {
    expect(() => parseEdgeFunctionActivationManifest('{"framework":"express"}'))
      .toThrow("unsupported framework");
  });
});
