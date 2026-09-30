import { expect, test } from "bun:test";
import type { VerifiedDeliveryExecutableArchive } from "@supacloud/delivery";
import { APPLICATION_DEVELOPMENT_LIMITS } from "@supacloud/delivery/development";
import {
  APPLICATION_DEVELOPMENT_ARTIFACT,
  APPLICATION_DEVELOPMENT_MAX_BYTES,
  ApplicationDevelopmentError,
  extractApplicationDevelopment,
} from "../../src/services/application-development.service";

const validContext = {
  schema: "supacloud.application-development.v1",
  source: "current-graph", deploymentVerified: false,
  modules: [{ name: "reviews", className: "ReviewsModule", file: "src/reviews.ts",
    providers: [], controllers: ["ReviewsController"], commands: [], jobs: [], queries: [], resources: ["reviews-db"] }],
  routes: [{ module: "reviews", method: "GET", path: "/reviews", controller: "ReviewsController", handler: "list", aspects: [] }],
  commands: [], jobs: [], resources: [{ name: "reviews-db", kind: "database" }],
  resourceUses: [], executionPlans: [], diagnostics: [],
  omitted: { modules: 0, providers: 0, routes: 0, commands: 0, jobs: 0, resources: 0, resourceUses: 0, plans: 0, diagnostics: 0 },
  limits: APPLICATION_DEVELOPMENT_LIMITS,
};

function archive(bytes?: Buffer): VerifiedDeliveryExecutableArchive {
  // Only fields consumed by this unit are supplied; integration readers verify the full archive.
  return {
    manifest: { plan: { targets: [{ name: "api", modules: [{ name: "reviews" }],
      routes: validContext.routes, jobs: [] }] } } as VerifiedDeliveryExecutableArchive["manifest"],
    objects: [{
      object: { name: "api", objectId: "b".repeat(64) } as VerifiedDeliveryExecutableArchive["objects"][number]["object"],
      files: new Map(bytes === undefined ? [] : [[APPLICATION_DEVELOPMENT_ARTIFACT, bytes]]),
    }],
  };
}
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) ?? "");
const extract = (value: unknown) => extractApplicationDevelopment(archive(encoded(value)), "api");
const invalid = new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_INVALID");

test("extracts a strictly validated context bound to the selected target", () => {
  const result = extract(validContext);
  expect(result.correlation).toBe("verified-build-snapshot");
  expect(result.delivery).toEqual({ target: "api", objectId: "b".repeat(64), artifactVerified: true });
  expect(result.context).toEqual(validContext);
  expect(result.context).not.toBe(validContext);
});

test("rejects unknown targets and missing artifacts with stable codes", () => {
  expect(() => extractApplicationDevelopment(archive(encoded(validContext)), "worker"))
    .toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TARGET_NOT_FOUND"));
  expect(() => extractApplicationDevelopment(archive(), "api"))
    .toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_MISSING"));
});

test("rejects malformed nested rows, unknown fields and forged limits", () => {
  for (const value of [
    undefined, { ...validContext, schema: "v2" }, { ...validContext, source: "runtime" },
    { ...validContext, deploymentVerified: true }, { ...validContext, routes: null },
    { ...validContext, modules: [null] }, { ...validContext, resources: [{ name: "db" }] },
    { ...validContext, unexpected: "private payload" },
    { ...validContext, omitted: {} }, { ...validContext, omitted: { ...validContext.omitted, modules: -1 } },
    { ...validContext, limits: { ...validContext.limits, modules: 1000 } },
    { ...validContext, diagnostics: [{ code: "SC8101", severity: "error", message: "private payload" }] },
    { ...validContext, routes: [{ ...validContext.routes[0], schemaKinds: { body: "secret" } }] },
  ]) expect(() => extract(value)).toThrow(invalid);
});

test("rejects unsafe source paths, invalid stages and aggregate provider overflow", () => {
  for (const file of ["/etc/passwd", "C:\\private.ts", "../private.ts", "file:private", "src/../private.ts"]) {
    expect(() => extract({ ...validContext, modules: [{ ...validContext.modules[0], file }] })).toThrow(invalid);
  }
  expect(() => extract({ ...validContext,
    executionPlans: [{ module: "reviews", kind: "route", name: "GET /reviews", stages: ["private-source()"] }] })).toThrow(invalid);
  expect(() => extract({ ...validContext,
    modules: [{ ...validContext.modules[0], providers: Array(129).fill("Provider") }] })).toThrow(invalid);
});

test("rejects foreign module, route, command, job and execution-plan ownership", () => {
  const cases = [
    { ...validContext, modules: [{ ...validContext.modules[0], name: "other" }] },
    { ...validContext, routes: [{ ...validContext.routes[0], path: "/foreign" }] },
    { ...validContext, commands: [{ module: "other", name: "create", transaction: "none", idempotency: "none", resources: [] }] },
    { ...validContext, jobs: [{ module: "reviews", name: "foreign", resources: [] }] },
    { ...validContext, resourceUses: [{ module: "reviews", ownerKind: "job", owner: "foreign", resource: "reviews-db", operations: ["read"] }] },
    { ...validContext, executionPlans: [{ module: "reviews", kind: "route", name: "GET /foreign", stages: ["handler"] }] },
  ];
  for (const value of cases) expect(() => extract(value)).toThrow(invalid);
  const missingPlan = archive(encoded(validContext));
  missingPlan.manifest.plan.targets = [];
  expect(() => extractApplicationDevelopment(missingPlan, "api")).toThrow(invalid);
});

test("rejects malformed UTF-8 rather than silently replacing invalid bytes", () => {
  const bytes = encoded(validContext);
  bytes[bytes.indexOf("reviews")] = 0xff;
  expect(() => extractApplicationDevelopment(archive(bytes), "api")).toThrow(invalid);
  expect(() => extractApplicationDevelopment(archive(Buffer.from("{")), "api")).toThrow(invalid);
});

test("bounds raw input and formatted output and permits declared omissions", () => {
  expect(() => extractApplicationDevelopment(archive(Buffer.alloc(APPLICATION_DEVELOPMENT_MAX_BYTES + 1)), "api"))
    .toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TOO_LARGE"));
  expect(extract({ ...validContext, modules: [], omitted: { ...validContext.omitted, modules: 1 } }).context.omitted.modules).toBe(1);
  for (const count of [1000, 1200]) {
    const huge = { ...validContext, modules: [{ ...validContext.modules[0], tags: Array(count).fill("x".repeat(512)) }] };
    expect(() => extract(huge)).toThrow(new ApplicationDevelopmentError("APPLICATION_DEVELOPMENT_TOO_LARGE"));
  }
});
