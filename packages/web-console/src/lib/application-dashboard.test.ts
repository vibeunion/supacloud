import { expect, test } from "bun:test";
import {
  ApplicationRuntimeChanged, loadApplicationReleases, loadApplicationRuntime,
  parseApplicationReleases, parseApplicationRuntime, validApplicationScope,
} from "./application-dashboard";

const scope = { ref: "demo-project", application: "reviews", environment: "acceptance" };
const releaseId = "a".repeat(64);
const activationId = "11234567-89ab-4def-8123-456789abcdef";
const target = (name: string, kind: "http" | "worker" = "http") => ({
  name, kind, object_id: "b".repeat(64), entrypoint: "bundle/index.js" as const,
});
const runtime = {
  project_ref: scope.ref, application_id: scope.application, environment_id: scope.environment,
  configuration_id: "21234567-89ab-4def-8123-456789abcdef",
  readiness: {
    project_ref: scope.ref, application_id: scope.application, environment_id: scope.environment,
    release_id: releaseId, activation_id: activationId, ready: true,
    targets: [{
      target: "api", kind: "http" as const,
      unit: `supacloud-application-${scope.ref}-${activationId}-api.service`,
      pid: 42, invocation_id: "c".repeat(32), ready: true, code: "READY" as const,
    }],
  },
};
const release = {
  schema: "supacloud.application-release.v1" as const,
  project_ref: scope.ref, application_id: scope.application, release_id: releaseId,
  manifest_sha256: "d".repeat(64), created_at: "2026-09-28T00:00:00.000Z", targets: [target("api")],
};
const request = (payload: unknown, status = 200) => async (url: string, init: RequestInit) => {
  expect(url).toBe("/v1/projects/demo-project/applications/reviews/releases?limit=50");
  expect(init.cache).toBe("no-store");
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
};

test("application scope accepts project/application/environment IDs only", () => {
  expect(validApplicationScope(scope)).toBe(true);
  expect(validApplicationScope({ ...scope, ref: "UPPER" })).toBe(false);
  expect(validApplicationScope({ ...scope, application: "../release" })).toBe(false);
});

test("runtime decoder preserves null active state and validates ready identities", () => {
  expect(parseApplicationRuntime({ ...runtime, readiness: null }, scope).readiness).toBeNull();
  expect(parseApplicationRuntime(runtime, scope).readiness?.targets[0]?.code).toBe("READY");
  expect(() => parseApplicationRuntime({
    ...runtime,
    readiness: { ...runtime.readiness, ready: false },
  }, scope)).toThrow();
});

test("release decoder validates immutable records and cursor ordering", () => {
  expect(parseApplicationReleases({
    project_ref: scope.ref, application_id: scope.application, releases: [release], next_cursor: null,
  }, scope).releases[0]?.release_id).toBe(releaseId);
  expect(() => parseApplicationReleases({
    project_ref: scope.ref, application_id: scope.application, releases: [{ ...release, release_id: "0".repeat(64) }],
    next_cursor: null,
  }, scope, releaseId)).toThrow();
});

test("loaders use encoded scope, no-store and bounded validated JSON", async () => {
  const runtimeResponse = await loadApplicationRuntime(scope, async (url, init) => {
    expect(url).toBe("/v1/projects/demo-project/applications/reviews/environments/acceptance/runtime");
    expect(init.cache).toBe("no-store");
    return new Response(JSON.stringify(runtime));
  }, new AbortController().signal);
  expect(runtimeResponse.readiness?.ready).toBe(true);
  const releases = await loadApplicationReleases(scope, request({
    project_ref: scope.ref, application_id: scope.application, releases: [release], next_cursor: null,
  }), new AbortController().signal);
  expect(releases.releases).toHaveLength(1);
});

test("runtime 409 is surfaced as an observation change", async () => {
  await expect(loadApplicationRuntime(scope, async () => new Response(JSON.stringify({
    code: "APPLICATION_RUNTIME_CHANGED", error: "changed",
  }), { status: 409 }), new AbortController().signal)).rejects.toBeInstanceOf(ApplicationRuntimeChanged);
});

test("decoders reject foreign scope, duplicate targets and invalid process proof", () => {
  for (const patch of [{ pid: 0 }, { invocation_id: null }, { code: "HTTP_NOT_READY" }, { unit: "foreign.service" }]) {
    expect(() => parseApplicationRuntime({ ...runtime, readiness: {
      ...runtime.readiness, targets: [{ ...runtime.readiness.targets[0], ...patch }],
    } }, scope)).toThrow();
  }
  expect(() => parseApplicationRuntime({ ...runtime, application_id: "foreign" }, scope)).toThrow();
  expect(() => parseApplicationRuntime({ ...runtime, readiness: {
    ...runtime.readiness, targets: [...runtime.readiness.targets, ...runtime.readiness.targets],
  } }, scope)).toThrow();
  for (const patch of [{ created_at: "yesterday" }, { targets: [target("api"), target("api")] }, { application_id: "foreign" }]) {
    expect(() => parseApplicationReleases({
      project_ref: scope.ref, application_id: scope.application, releases: [{ ...release, ...patch }], next_cursor: null,
    }, scope)).toThrow();
  }
});

test("releases preserve empty lists and validate continuation", async () => {
  const envelope = { project_ref: scope.ref, application_id: scope.application };
  expect(parseApplicationReleases({ ...envelope, releases: [], next_cursor: null }, scope).releases).toEqual([]);
  expect(() => parseApplicationReleases({ ...envelope, releases: [], next_cursor: releaseId }, scope)).toThrow();
  expect(() => parseApplicationReleases({ ...envelope, releases: [release, release], next_cursor: null }, scope)).toThrow();
  await loadApplicationReleases(scope, async (url) => {
    expect(url).toEndWith(`&cursor=${"0".repeat(64)}`);
    return Response.json({ ...envelope, releases: [release], next_cursor: releaseId });
  }, new AbortController().signal, "0".repeat(64));
});

test("transport rejects errors, malformed and oversized responses without empty fallbacks", async () => {
  for (const response of [
    new Response("no", { status: 403 }), new Response("{"),
    new Response(" ".repeat(1024 * 1024 + 1)),
  ]) {
    await expect(loadApplicationReleases(scope, async () => response, new AbortController().signal)).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  let requested = false;
  await expect(loadApplicationRuntime(scope, async () => {
    requested = true;
    return Response.json(runtime);
  }, controller.signal)).rejects.toThrow();
  expect(requested).toBe(false);
});
