import { describe, expect, test } from "bun:test";
import { edgeFunctionActivationGenerationPath } from "./function-activation";

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
