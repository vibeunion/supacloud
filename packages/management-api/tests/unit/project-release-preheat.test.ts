import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProjectReleasePreheatRoutes } from "../../../edge-runtime/project-release-preheat";
import { WorkerPool, type VersionedPreheatRequest } from "../../../edge-runtime/worker-pool";
import type { EdgeRuntimePreheatIdentity } from "../../../edge-runtime/preheat-attestation";

const root = await mkdtemp(join(homedir(), ".supacloud-release-preheat-"));
const oldDirectory = process.env.EDGE_FUNCTIONS_DIR;
process.env.EDGE_FUNCTIONS_DIR = root;
const { edgeFunctionService, prepareProjectReleaseMembers, getVersionedArtifactPath } = await import("../../src/services/edge-function.service");
afterAll(async () => {
  if (oldDirectory === undefined) delete process.env.EDGE_FUNCTIONS_DIR;
  else process.env.EDGE_FUNCTIONS_DIR = oldDirectory;
  await rm(root, { recursive: true, force: true });
});

test.each([2, 128])("preparation validates %i members against staged immutable artifacts", async (count) => {
  const ref = `releasepreheat${count}`;
  const slugs = ["one", "two", ...Array.from({ length: count - 2 }, (_, index) => `member${index}`)];
  const staged = new Map<string, { version: string; artifact_sha256: string }>();
  for (const slug of slugs) {
    staged.set(slug, await edgeFunctionService.stageVersion({
      ref, slug, code: `export default () => new Response("${slug}");`,
    }));
    expect(await edgeFunctionService.getActiveVersion(ref, slug)).toBe("absent");
  }
  const originalFetch = globalThis.fetch;
  const instance = crypto.randomUUID();
  let corrupt = false;
  let preheats = 0;
  let foregroundGeneration = 0;
  let backgroundGeneration = 0;
  let responseFault: "none" | "missing" | "duplicate" | "epoch" | "digest" | "environment"
    | "oversize-declared" | "oversize-stream" = "none";
  let responseCancelled = false;
  let batchBytes = 0;
  let batchCalls = 0;
  globalThis.fetch = (async (input, init) => {
    expect(init?.redirect).toBe("error");
    const url = new URL(String(input));
    if (url.pathname === "/internal/runtime-activation-epoch") return Response.json({
      project_release_schema: "supacloud.project-function-release.v1",
      project_preheat_schema: "supacloud.project-release-preheat.v1",
      runtime_instance_id: instance, foreground_generation: foregroundGeneration, background_generation: backgroundGeneration,
    });
    expect(url.pathname).toBe(`/internal/project-release-preheat/${ref}`);
    batchCalls++;
    if (responseFault === "oversize-declared" || responseFault === "oversize-stream") {
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
        cancel() { responseCancelled = true; },
      }), {
        headers: responseFault === "oversize-declared" ? { "content-length": String(1024 * 1024 + 1) } : {},
      });
    }
    const request = JSON.parse(String(init?.body)) as {
      functions: Array<{ slug: string; version: string }>;
      foreground_generation: number;
      background_generation: number;
    };
    preheats += request.functions.length;
    foregroundGeneration++;
    backgroundGeneration++;
    const pool = (slug: string, artifact: { version: string; artifact_sha256: string }, profile: string, projectRef = ref) => {
      const identity = {
        schema: "supacloud.edge-runtime-preheat-attestation.v1", project_ref: projectRef, function_slug: slug,
        requested_version: artifact.version, target_version: artifact.version, resolved_version: artifact.version,
        artifact_sha256: artifact.artifact_sha256, verify_jwt: true, activation_id: null,
        runtime_instance_id: instance, execution_profile: profile,
        module_env_proof: `hmac-sha256:${profile === "foreground" ? "c".repeat(64) : "d".repeat(64)}`,
        module_loaded: true,
        tenant_env: { loaded_revision: `hmac-sha256:${"a".repeat(64)}`, env_proof: `hmac-sha256:${"b".repeat(64)}`, load_state: "loaded", load_source: "management_api" },
      };
      return {
        attempted: 1, succeeded: 1, cacheHits: 0, cacheMisses: 1, durationMs: 1, attestation: identity,
        rotation: {
          generation: profile === "foreground" ? foregroundGeneration : backgroundGeneration,
          attempted: 0, idleRetired: 0, busyTainted: 0, alreadyTainted: 0, immediateReplacements: 0,
        },
      };
    };
    const body = {
      schema: "supacloud.project-release-preheat.v1", project_ref: ref,
      runtime_instance_id: instance, foreground_generation: foregroundGeneration,
      background_generation: backgroundGeneration,
      members: request.functions.filter((_entry, index) => responseFault !== "missing" || index !== 1).map(({ slug, version }, index) => {
        const artifact = staged.get(slug)!;
        const foreground = pool(slug, artifact, "foreground");
        const background = pool(slug, artifact, "background", corrupt ? "foreign" : ref);
        if (responseFault === "digest") background.attestation.artifact_sha256 = "f".repeat(64);
        if (responseFault === "epoch") background.rotation.generation++;
        if (responseFault === "environment" && index === 1) {
          foreground.attestation.tenant_env.env_proof = `hmac-sha256:${"e".repeat(64)}`;
          background.attestation.tenant_env.env_proof = foreground.attestation.tenant_env.env_proof;
        }
        return {
          slug: responseFault === "duplicate" ? "one" : slug,
          result: {
            preheated: `${ref}_${slug}_v${version}`, version, success: true,
            attestation: foreground.attestation, foreground, background,
          },
        };
      }),
    };
    batchBytes = Buffer.byteLength(JSON.stringify(body));
    return Response.json(body);
  }) as typeof fetch;
  const functions = [...staged].map(([slug, artifact]) => ({ slug, version: artifact.version, expected_activation_id: "legacy" }));
  try {
    const prepared = await prepareProjectReleaseMembers(ref, functions);
    expect(Object.keys(prepared)).toEqual(slugs);
    expect(preheats).toBe(count);
    expect(batchCalls).toBe(1);
    if (count === 128) expect(batchBytes).toBeGreaterThan(64 * 1024);
    corrupt = true;
    await expect(prepareProjectReleaseMembers(ref, functions)).rejects.toThrow();
    corrupt = false;
    for (const fault of ["missing", "duplicate", "epoch", "digest", "environment"] as const) {
      responseFault = fault;
      await expect(prepareProjectReleaseMembers(ref, functions)).rejects.toThrow();
    }
    for (const fault of ["oversize-declared", "oversize-stream"] as const) {
      responseFault = fault;
      responseCancelled = false;
      await expect(prepareProjectReleaseMembers(ref, functions)).rejects.toThrow("too large");
      expect(responseCancelled).toBe(true);
    }
    expect(await edgeFunctionService.getActiveVersion(ref, "one")).toBe("absent");
  } finally { globalThis.fetch = originalFetch; }
});

function readinessIdentity(slug: string, profile: "foreground" | "background"): EdgeRuntimePreheatIdentity {
  return {
    schema: "supacloud.edge-runtime-preheat-attestation.v1",
    project_ref: "batchtest", function_slug: slug, requested_version: "1", target_version: "1", resolved_version: "1",
    artifact_sha256: "a".repeat(64), verify_jwt: true, activation_id: null,
    runtime_instance_id: "11111111-1111-4111-8111-111111111111",
    execution_profile: profile, module_env_proof: `hmac-sha256:${(profile === "foreground" ? "c" : "d").repeat(64)}`,
    tenant_env: {
      loaded_revision: `hmac-sha256:${"a".repeat(64)}`, env_proof: `hmac-sha256:${"b".repeat(64)}`,
      load_state: "loaded", load_source: "management_api",
    },
  };
}

function routeFixture() {
  const epoch = {
    runtime_instance_id: "11111111-1111-4111-8111-111111111111", foreground_generation: 0, background_generation: 0,
  };
  let current = true;
  let leased = false;
  let prepared = 0;
  let backgroundHold: (() => Promise<void>) | undefined;
  let foregroundFails = false;
  const requests = (profile: "foreground" | "background", functions: Array<{ slug: string; version: string }>) =>
    functions.map(({ slug }): VersionedPreheatRequest => ({
      functionId: `batchtest_${slug}_v1`, functionPath: `/unused/${slug}`, projectRoot: "/unused",
      projectRef: "batchtest", env: {}, moduleVersion: "1", attestation: readinessIdentity(slug, profile),
    }));
  const pool = (profile: "foreground" | "background") => ({
    async preheatReleaseIdleWorkers(entries: readonly VersionedPreheatRequest[]) {
      if (profile === "foreground" && foregroundFails) throw new Error("failed");
      if (profile === "background") await backgroundHold?.();
      const generation = profile === "foreground" ? ++epoch.foreground_generation : ++epoch.background_generation;
      return entries.map(entry => ({
        attempted: 1, succeeded: 1, cacheHits: 0, cacheMisses: 1, durationMs: 1,
        attestation: { ...entry.attestation!, module_loaded: true as const },
        rotation: { generation, attempted: 1, idleRetired: 1, busyTainted: 0, alreadyTainted: 0, immediateReplacements: 1 },
      }));
    },
  });
  const app = createProjectReleasePreheatRoutes({
    authorize: request => request.headers.get("authorization") === "Bearer internal-test" ? undefined : new Response(null, { status: 401 }),
    epoch: () => ({ ...epoch }),
    assertAvailable() { if (leased) throw new Error("activation in progress"); },
    async prepare(_ref, functions) {
      prepared++;
      return {
        foreground: requests("foreground", functions), background: requests("background", functions),
        assertCurrent() { if (!current) throw new Error("environment changed"); },
      };
    },
    foreground: pool("foreground"), background: pool("background"),
  });
  const body = () => ({ ...epoch, functions: ["one", "two"].map(slug => ({ slug, version: "1" })) });
  return {
    epoch, body,
    request: (value: unknown = body(), authorized = true) => app.handle(new Request("http://localhost/internal/project-release-preheat/batchtest", {
      method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer internal-test" } : {}) },
      body: JSON.stringify(value),
    })),
    prepared: () => prepared,
    invalidate: () => { current = false; },
    lease: () => { leased = true; },
    failForeground: () => { foregroundFails = true; },
    holdBackground: (wait: () => Promise<void>) => { backgroundHold = wait; },
  };
}

test("runtime batch endpoint authenticates and binds all members to one rotation per pool", async () => {
  const f = routeFixture();
  expect((await f.request(f.body(), false)).status).toBe(401);
  expect(f.prepared()).toBe(0);
  const response = await f.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    schema: "supacloud.project-release-preheat.v1", project_ref: "batchtest",
    foreground_generation: 1, background_generation: 1,
    members: [{ slug: "one" }, { slug: "two" }],
  });
});

test("stale epochs, duplicate members and individual activation leases never warm pools", async () => {
  for (const fault of ["epoch", "duplicate", "lease"] as const) {
    const f = routeFixture();
    const body = f.body();
    if (fault === "epoch") body.foreground_generation++;
    if (fault === "duplicate") body.functions[1]!.slug = body.functions[0]!.slug;
    if (fault === "lease") f.lease();
    expect((await f.request(body)).status).toBe(409);
    expect(f.prepared()).toBe(0);
    expect(f.epoch.foreground_generation).toBe(0);
    expect(f.epoch.background_generation).toBe(0);
  }
});

test("runtime waits for both pools on failure and rejects environment changes after preparation", async () => {
  for (const fail of [false, true]) {
    const f = routeFixture();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.holdBackground(async () => { started.resolve(); await finish.promise; });
    if (fail) f.failForeground();
    let finished = false;
    const response = f.request().then(result => { finished = true; return result; });
    await started.promise;
    expect(finished).toBe(false);
    if (!fail) f.invalidate();
    finish.resolve();
    expect((await response).status).toBe(409);
  }
});

test.skipIf(process.platform !== "linux")("real workers keep every release member warm after only one rotation", async () => {
  const ref = "batchtest";
  const pool = new WorkerPool({ size: 1, requestTimeout: 2000 });
  try {
    const requests: VersionedPreheatRequest[] = [];
    for (const slug of ["first", "second"]) {
      const artifact = await edgeFunctionService.stageVersion({
        ref, slug, code: `export default () => new Response("${slug}");`,
      });
      const functionPath = await getVersionedArtifactPath(ref, slug, artifact.version);
      if (!functionPath) throw new Error("Missing staged artifact");
      requests.push({
        functionId: `${ref}_${slug}_v${artifact.version}`, functionPath, projectRoot: join(root, ref),
        projectRef: ref, env: {}, moduleVersion: artifact.version,
        attestation: { ...readinessIdentity(slug, "foreground"), artifact_sha256: artifact.artifact_sha256 },
      });
    }
    const result = await pool.preheatReleaseIdleWorkers(requests);
    expect(result.map(entry => entry.rotation.generation)).toEqual([1, 1]);
    expect(result.map(entry => entry.succeeded)).toEqual([1, 1]);
    for (const request of requests) {
      expect(await pool.preheatIdleWorkers(request.functionId, request.functionPath, request.projectRoot, request.env, {
        projectRef: ref, moduleVersion: request.moduleVersion, attestation: request.attestation,
      })).toMatchObject({ cacheHits: 1, succeeded: 1 });
    }
    expect(pool.generation).toBe(1);
  } finally { await pool.shutdown(); }
});
