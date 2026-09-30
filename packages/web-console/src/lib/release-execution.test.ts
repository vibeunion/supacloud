import { expect, test } from "bun:test";
import { loadReleaseExecution, parseReleaseExecution } from "./release-execution";

const scope = { ref: "demo-project", application: "reviews", environment: "acceptance" };
const releaseId = "a".repeat(64);
const target = "api";
const at = "2026-09-30T01:00:00.000Z";
const component = (name: string, overrides: Record<string, unknown> = {}) => ({
  name, status: "unknown", required: false, version: null, detail: null, observedAt: null, ...overrides,
});
const response = {
  project_ref: scope.ref, application_id: scope.application, release_id: releaseId,
  schema: "supacloud.release-execution.v1" as const, correlation: "release-execution-observation" as const,
  target, manifestSha256: "b".repeat(64), deploymentVerified: true,
  components: [
    component("application", { status: "succeeded", required: true, observedAt: at }),
    component("migrations", { status: "succeeded", required: true, version: "2", observedAt: at }),
    component("configuration"),
    component("resources"),
    component("secrets"),
    component("health", { status: "succeeded", required: true, observedAt: at }),
  ],
  recovery: { application: "previous release", database: "repair path", storage: "object version" },
  notes: ["Runtime observation only."],
};

test("release execution decoder accepts a consistent verified record", () => {
  const parsed = parseReleaseExecution(response, scope, releaseId, target);
  expect(parsed.deploymentVerified).toBe(true);
  expect(parsed.components.find(entry => entry.name === "migrations")).toMatchObject({ required: true, version: "2" });
  expect(parsed.recovery.application).toBe("previous release");
});

test("release execution decoder rejects inconsistent or unverifiable records", () => {
  const cases: Record<string, unknown>[] = [
    { ...response, deploymentVerified: false },
    { ...response, project_ref: "other" },
    { ...response, target: "workers" },
    { ...response, manifestSha256: "short" },
    { ...response, components: response.components.map(entry => entry.name === "health" ? { ...entry, status: "unknown", observedAt: null } : entry) },
    { ...response, components: response.components.map(entry => entry.name === "secrets" ? { ...entry, status: "failed", observedAt: at } : entry) },
    { ...response, components: response.components.map(entry => entry.name === "configuration" ? { ...entry, version: "x" } : entry) },
    { ...response, components: response.components.map(entry => entry.name === "application" ? { ...entry, observedAt: null } : entry) },
    { ...response, components: [...response.components].reverse() },
    { ...response, notes: ["ok", 3] },
  ];
  for (const value of cases) expect(() => parseReleaseExecution(value, scope, releaseId, target)).toThrow();
});

test("release execution loader binds the release and target in its URL", async () => {
  let seen = "";
  const request = async (url: string, init: RequestInit) => {
    seen = url;
    expect(init.cache).toBe("no-store");
    return Response.json(response);
  };
  const loaded = await loadReleaseExecution(scope, releaseId, target, request, new AbortController().signal);
  expect(loaded.schema).toBe("supacloud.release-execution.v1");
  expect(seen).toBe(`/v1/projects/demo-project/applications/reviews/releases/${releaseId}/execution?target=api`);
  expect(() => loadReleaseExecution(scope, releaseId, "Bad_Target", request, new AbortController().signal)).toThrow();
});