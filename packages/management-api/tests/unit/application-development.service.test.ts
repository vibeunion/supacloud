import { expect, test } from "bun:test";
import type { VerifiedDeliveryExecutableArchive } from "@supacloud/delivery";
import {
  APPLICATION_DEVELOPMENT_ARTIFACT,
  APPLICATION_DEVELOPMENT_MAX_BYTES,
  ApplicationDevelopmentError,
  extractApplicationDevelopment,
} from "../../src/services/application-development.service";

const validContext = {
  schema: "supacloud.application-development.v1",
  source: "current-graph",
  deploymentVerified: false,
  modules: [{ name: "reviews" }],
  routes: [],
  commands: [],
  jobs: [],
  resources: [{ name: "reviews-db" }],
  resourceUses: [],
  executionPlans: [],
  diagnostics: [],
  omitted: {},
  limits: { outputBytes: 65536 },
};

function archive(files: Record<string, Uint8Array | undefined>): VerifiedDeliveryExecutableArchive {
  return {
    manifest: {} as VerifiedDeliveryExecutableArchive["manifest"],
    objects: [{
      object: { name: "api", objectId: "b".repeat(64) } as VerifiedDeliveryExecutableArchive["objects"][number]["object"],
      files: new Map(Object.entries(files)) as Map<string, Buffer>,
    }],
  };
}

function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

test("extracts and validates a delivered development context", () => {
  const result = extractApplicationDevelopment(archive({ [APPLICATION_DEVELOPMENT_ARTIFACT]: encoded(validContext) }), "api");
  expect(result.correlation).toBe("verified-build-snapshot");
  expect(result.delivery).toEqual({ target: "api", objectId: "b".repeat(64), artifactVerified: true });
  expect(result.context.schema).toBe("supacloud.application-development.v1");
});

test("rejects an unknown delivery target", () => {
  expect(() => extractApplicationDevelopment(archive({ [APPLICATION_DEVELOPMENT_ARTIFACT]: encoded(validContext) }), "worker"))
    .toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TARGET_NOT_FOUND"));
});

test("rejects a target without the development artifact", () => {
  expect(() => extractApplicationDevelopment(archive({}), "api"))
    .toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_MISSING"));
});

test("rejects malformed or unverifiable documents", () => {
  const cases: unknown[] = [
    undefined,
    { ...validContext, schema: "supacloud.application-development.v2" },
    { ...validContext, source: "runtime" },
    { ...validContext, deploymentVerified: true },
    { ...validContext, routes: null },
    { ...validContext, omitted: [] },
    { ...validContext, limits: null },
  ];
  for (const value of cases) {
    expect(() => extractApplicationDevelopment(archive({ [APPLICATION_DEVELOPMENT_ARTIFACT]: encoded(value) }), "api"))
      .toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID"));
  }
  expect(() => extractApplicationDevelopment(archive({ [APPLICATION_DEVELOPMENT_ARTIFACT]: new TextEncoder().encode("{") }), "api"))
    .toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID"));
});

test("bounds the accepted document size", () => {
  const oversized = new Uint8Array(APPLICATION_DEVELOPMENT_MAX_BYTES + 1);
  expect(() => extractApplicationDevelopment(archive({ [APPLICATION_DEVELOPMENT_ARTIFACT]: oversized }), "api"))
    .toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TOO_LARGE"));
});