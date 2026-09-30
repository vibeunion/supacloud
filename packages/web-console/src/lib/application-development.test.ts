import { expect, test } from "bun:test";
import { developmentLimits, loadApplicationDevelopment, parseApplicationDevelopment } from "./application-development";

const scope = { ref: "demo-project", application: "reviews", environment: "acceptance" };
const releaseId = "a".repeat(64);
const target = "api";
const context = {
  schema: "supacloud.application-development.v1" as const,
  source: "current-graph" as const, deploymentVerified: false as const,
  modules: [{ name: "reviews", className: "ReviewsModule", providers: ["ReviewsService"],
    controllers: ["ReviewsController"], commands: ["CreateReview"], jobs: [], queries: [], resources: ["reviews-db"] }],
  routes: [{ module: "reviews", method: "POST", path: "/reviews", controller: "ReviewsController", handler: "create", aspects: [] }],
  commands: [{ module: "reviews", name: "CreateReview", transaction: "required" as const, idempotency: "required" as const,
    resources: [{ resource: "reviews-db", operations: ["write"] }] }],
  jobs: [], resources: [{ name: "reviews-db", kind: "database" as const }],
  resourceUses: [{ module: "reviews", owner: "CreateReview", ownerKind: "command" as const, resource: "reviews-db", operations: ["write"] }],
  executionPlans: [], diagnostics: [{ code: "SC8103", severity: "warn" as const }],
  omitted: { modules: 0, providers: 0, routes: 0, commands: 0, jobs: 0, resources: 0, resourceUses: 0, plans: 0, diagnostics: 0 },
  limits: developmentLimits,
};
const response = {
  project_ref: scope.ref, application_id: scope.application, release_id: releaseId,
  target, object_id: "b".repeat(64), correlation: "verified-build-snapshot" as const, context,
};

test("development decoder returns a detached allowlisted snapshot", () => {
  const parsed = parseApplicationDevelopment({ ...response, private: "discard" }, scope, releaseId, target);
  expect(parsed.context).toEqual(context);
  expect(parsed.context).not.toBe(context);
  expect(parsed).not.toHaveProperty("private");
  expect(parsed.context.executionPlans).toEqual([]);
});

test("development decoder rejects foreign identities and an unexpected object digest", () => {
  for (const value of [
    { ...response, project_ref: "other" }, { ...response, application_id: "other" },
    { ...response, release_id: "c".repeat(64) }, { ...response, target: "workers" },
    { ...response, correlation: "current-source" }, { ...response, object_id: "b".repeat(64) + "\n" },
  ]) expect(() => parseApplicationDevelopment(value, scope, releaseId, target)).toThrow();
  expect(() => parseApplicationDevelopment(response, scope, releaseId, target, "c".repeat(64))).toThrow();
  expect(parseApplicationDevelopment(response, scope, releaseId, target, response.object_id).object_id).toBe(response.object_id);
});

test("development decoder shares strict nested, path, stage and limit validation", () => {
  for (const invalid of [
    { ...context, deploymentVerified: true }, { ...context, schema: "v2" },
    { ...context, modules: [null] }, { ...context, unknown: "private" },
    { ...context, limits: { ...developmentLimits, modules: 1000 } },
    { ...context, omitted: {} }, { ...context, executionPlans: [null] },
    { ...context, executionPlans: [{ module: "reviews", kind: "route", name: "POST /reviews", stages: ["execute private source"] }] },
    { ...context, diagnostics: [{ code: "SC8103", severity: "warn", file: "../private.ts" }] },
    { ...context, diagnostics: [{ code: "SC8103", severity: "warn", line: 0 }] },
    { ...context, diagnostics: [{ code: "SC8103", severity: "warn", message: "private" }] },
  ]) expect(() => parseApplicationDevelopment({ ...response, context: invalid }, scope, releaseId, target)).toThrow();
});

test("development loader binds the URL and captures scope before asynchronous transport", async () => {
  const selected = { ...scope };
  const calls: string[] = [];
  const request = async (url: string, init: RequestInit) => {
    calls.push(url);
    expect(init.cache).toBe("no-store");
    selected.ref = "other";
    selected.application = "other-app";
    return Response.json(response);
  };
  const loaded = await loadApplicationDevelopment(selected, releaseId, target, request, new AbortController().signal, response.object_id);
  expect(loaded.project_ref).toBe(scope.ref);
  expect(calls[0]).toBe(`/v1/projects/demo-project/applications/reviews/releases/${releaseId}/development?target=api`);
  for (const bad of ["Bad_Target", "api\n"]) {
    expect(() => loadApplicationDevelopment(scope, releaseId, bad, request, new AbortController().signal)).toThrow();
  }
});

test("development transport rejects oversized, malformed UTF-8 and cancelled responses", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(response));
  bytes[20] = 0xff;
  for (const body of [new Uint8Array(530_000), bytes]) {
    await expect(loadApplicationDevelopment(scope, releaseId, target, async () => new Response(body), new AbortController().signal)).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(loadApplicationDevelopment(scope, releaseId, target, async () => {
    calls++; return Response.json(response);
  }, controller.signal)).rejects.toThrow();
  expect(calls).toBe(0);
});
