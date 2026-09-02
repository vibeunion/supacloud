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

describe("Edge Function capability and limit profiles", () => {
  test("defaults omitted capability and limit profiles to empty objects", () => {
    const config = parseEdgeFunctionActivationManifest('{"verify_jwt":true,"version":"1"}').config;
    expect(config.capabilities).toEqual({});
    expect(config.limits).toEqual({});
  });

  test("preserves declared capability and limit profiles", () => {
    const config = parseEdgeFunctionActivationManifest(JSON.stringify({
      version: "2",
      capabilities: { secrets: ["A"], outbound_hosts: ["api.example.com"], bindings: ["pgredis"] },
      limits: { timeout_ms: 5000, max_request_body_bytes: 1024 },
    })).config;
    expect(config.capabilities).toEqual({
      secrets: ["A"],
      outbound_hosts: ["api.example.com"],
      bindings: ["pgredis"],
    });
    expect(config.limits).toEqual({ timeout_ms: 5000, max_request_body_bytes: 1024 });
  });

  test("rejects malformed capability and limit profiles", () => {
    expect(() => parseEdgeFunctionActivationManifest(JSON.stringify({ capabilities: { secrets: [1] } })))
      .toThrow("invalid capabilities.secrets");
    expect(() => parseEdgeFunctionActivationManifest(JSON.stringify({ limits: { timeout_ms: 0 } })))
      .toThrow("invalid limits.timeout_ms");
  });

  test("rejects system-managed secrets in capability profiles", () => {
    expect(() => parseEdgeFunctionActivationManifest(JSON.stringify({
      capabilities: { secrets: ["SUPABASE_SERVICE_ROLE_KEY"] },
    }))).toThrow("reserved capabilities.secrets");
  });
});
