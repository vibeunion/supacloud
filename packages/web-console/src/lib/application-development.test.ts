import { expect, test } from "bun:test";
import { loadApplicationDevelopment, parseApplicationDevelopment } from "./application-development";

const scope = { ref: "demo-project", application: "reviews", environment: "acceptance" };
const releaseId = "a".repeat(64);
const target = "api";
const context = {
  schema: "supacloud.application-development.v1" as const,
  source: "current-graph" as const,
  deploymentVerified: false as const,
  modules: [{
    name: "reviews", className: "ReviewsModule", providers: ["ReviewsService"],
    controllers: ["ReviewsController"], commands: ["CreateReview"], jobs: [],
    queries: [], resources: ["reviews-db"],
  }],
  routes: [{ module: "reviews", method: "POST", path: "/reviews", controller: "ReviewsController", handler: "create", aspects: [] }],
  commands: [{ module: "reviews", name: "CreateReview", transaction: "required" as const, idempotency: "required" as const,
    resources: [{ resource: "reviews-db", operations: ["write"] }] }],
  jobs: [],
  resources: [{ name: "reviews-db", kind: "database" as const }],
  resourceUses: [{ module: "reviews", owner: "CreateReview", ownerKind: "command" as const, resource: "reviews-db", operations: ["write"] }],
  executionPlans: [],
  diagnostics: [{ code: "SC8103", severity: "warn" as const }],
  omitted: { modules: 0, providers: 0, routes: 0, commands: 0, jobs: 0, resources: 0, resourceUses: 0, plans: 0, diagnostics: 0 },
  limits: { outputBytes: 65536 },
};
const response = {
  project_ref: scope.ref, application_id: scope.application, release_id: releaseId,
  target, object_id: "b".repeat(64), correlation: "verified-build-snapshot" as const, context,
};

test("development decoder accepts a verified build snapshot", () => {
  const parsed = parseApplicationDevelopment(response, scope, releaseId, target);
  expect(parsed.correlation).toBe("verified-build-snapshot");
  expect(parsed.context.modules[0]?.name).toBe("reviews");
  expect(parsed.context.diagnostics[0]?.code).toBe("SC8103");
});

test("development decoder rejects mismatched or unverified documents", () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["foreign project", { ...response, project_ref: "other" }, releaseId, target],
    ["foreign release", { ...response, release_id: "c".repeat(64) }, releaseId, target],
    ["unknown target", { ...response, target: "workers" }, releaseId, target],
    ["unverified correlation", { ...response, correlation: "current-source" }, releaseId, target],
    ["deployment verified", { ...response, context: { ...context, deploymentVerified: true } }, releaseId, target],
    ["wrong schema", { ...response, context: { ...context, schema: "supacloud.application-development.v2" } }, releaseId, target],
    ["faltered route", { ...response, context: { ...context, routes: [{ ...context.routes[0], handler: 3 }] } }, releaseId, target],
    ["bad diagnostic", { ...response, context: { ...context, diagnostics: [{ code: "SC1", severity: "info" }] } }, releaseId, target],
    ["non-numeric omitted", { ...response, context: { ...context, omitted: { modules: -1 } } }, releaseId, target],
  ];
  for (const [, value, id, name] of cases) {
    expect(() => parseApplicationDevelopment(value, scope, id, name)).toThrow();
  }
});

test("development loader binds the release, target and scope in its URL", async () => {
  const calls: string[] = [];
  const request = async (url: string, init: RequestInit) => {
    calls.push(url);
    expect(init.cache).toBe("no-store");
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  const loaded = await loadApplicationDevelopment(scope, releaseId, target, request, new AbortController().signal);
  expect(loaded.release_id).toBe(releaseId);
  expect(calls[0]).toBe(
    `/v1/projects/demo-project/applications/reviews/releases/${releaseId}/development?target=api`,
  );
  expect(() => loadApplicationDevelopment(scope, releaseId, "Bad_Target", request, new AbortController().signal))
    .toThrow();
});