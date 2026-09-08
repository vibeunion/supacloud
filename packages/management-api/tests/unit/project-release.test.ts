import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReleaseMutationStore } from "../../src/services/project-release-mutation";
import type { ProjectMutationState } from "../../src/services/project-mutation.service";
import { PROJECT_RELEASE_FILE, parseProjectRelease } from "../../src/services/project-release-contract";

const root = await mkdtemp(join(homedir(), ".supacloud-project-release-test-"));
const originalDirectory = process.env.EDGE_FUNCTIONS_DIR;
process.env.EDGE_FUNCTIONS_DIR = root;
const { ProjectReleaseService } = await import("../../src/services/project-release.service");
const {
  projectFunctionDirectory, readProjectFunctionRelease, withProjectFunctionReleaseLock, edgeFunctionService,
} = await import("../../src/services/edge-function.service");
const { projectReleaseFunctionManifest } = await import("../../../edge-runtime/project-release");
afterAll(async () => {
  if (originalDirectory === undefined) delete process.env.EDGE_FUNCTIONS_DIR;
  else process.env.EDGE_FUNCTIONS_DIR = originalDirectory;
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const projectRef = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const states = new Map<string, ProjectMutationState>();
  let preheats = 0;
  let failPrepare = false;
  let loseLease = false;
  let interruption: "prepared" | "published" | null = null;
  const mutations: ReleaseMutationStore = {
    async begin(input) {
      const old = states.get(input.mutationId);
      if (old && old.requestFingerprint !== input.requestFingerprint) throw new Error("fingerprint conflict");
      const state: ProjectMutationState = old ?? {
        ...input, resourceKey: null, status: "pending", checkpoint: {}, receipt: null,
        responseStatus: null, failureCode: null, leaseOwner: null, leaseExpiresAt: null,
        fencingEpoch: 0, completedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      states.set(input.mutationId, state);
      if (["succeeded", "outcome_unknown", "failed_terminal"].includes(state.status)) return { state };
      state.status = "running";
      return { state, lease: {
        projectRef, mutationId: input.mutationId, leaseToken: crypto.randomUUID(), fencingEpoch: ++state.fencingEpoch,
      } };
    },
    async protect(_lease, action) { if (loseLease) throw new Error("lease lost"); await action(); },
    async success(lease, receipt) { Object.assign(states.get(lease.mutationId)!, { status: "succeeded", receipt }); },
    async failure(lease, uncertain, terminal) {
      states.get(lease.mutationId)!.status = uncertain ? "outcome_unknown" : terminal ? "failed_terminal" : "failed_retryable";
    },
    async recover(state) { state.status = "succeeded"; },
    async read(_ref, id) { return states.get(id) ?? null; },
  };
  const service = new ProjectReleaseService({
    directory: projectFunctionDirectory, current: readProjectFunctionRelease,
    lock: withProjectFunctionReleaseLock, mutations,
    async prepare(_ref, functions) {
      preheats++;
      if (failPrepare) throw new Error("preheat rejected");
      return Object.fromEntries(functions.map(({ slug, version }) => [slug, {
        config: { version, verify_jwt: true, framework: "fetch" },
        authority: {
          schema: "supacloud.edge-function-activation.v1" as const,
          activation_id: crypto.randomUUID(), activation_generation: 1, previous_activation_id: null,
          target_state: "active" as const, artifact_sha256: "a".repeat(64),
        },
      }]));
    },
    interruption(phase) { if (interruption === phase) { interruption = null; throw new Error(`interrupted ${phase}`); } },
  });
  const input = {
    projectRef, mutationId: crypto.randomUUID(), expectedReleaseId: null,
    functions: ["first", "second"].map((slug) => ({ slug, version: "1", expected_activation_id: "legacy" })),
    principal: { type: "master" as const, id: "test-owner" },
  };
  return {
    service, input, states, prepareCalls: () => preheats,
    fail: () => { failPrepare = true; },
    revoke: () => { loseLease = true; },
    interrupt: (phase: "prepared" | "published") => { interruption = phase; },
  };
}

test("one durable authority exposes the complete unit to Management and Edge", async () => {
  const f = fixture();
  const result = await f.service.publish(f.input);
  expect(result.active_release_id).toBe(f.input.mutationId);
  expect(result.functions.map((entry) => entry.slug)).toEqual(["first", "second"]);
  for (const entry of result.functions) {
    const runtime = await projectReleaseFunctionManifest(join(root, f.input.projectRef), entry.slug);
    expect(runtime?.authority?.activation_id).toBe(entry.activation_id);
    expect((await edgeFunctionService.getState(f.input.projectRef, entry.slug)).active_version).toBe("1");
  }
  expect((await f.service.publish(f.input)).replayed).toBe(true);
  expect(f.prepareCalls()).toBe(1);
  await expect(edgeFunctionService.updateConfig(f.input.projectRef, "first", { verify_jwt: false }, result.functions[0]!.activation_id))
    .rejects.toThrow("belongs to a project release");
  const staged = await edgeFunctionService.stageVersion({
    ref: f.input.projectRef, slug: "first", code: 'export default () => new Response("staged");',
  });
  expect(staged.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect((await f.service.status(f.input.projectRef)).active_release_id).toBe(f.input.mutationId);
});

test("preheat failure or a lost lease never publishes", async () => {
  for (const reason of ["prepare", "lease"]) {
    const f = fixture();
    if (reason === "prepare") f.fail(); else f.revoke();
    await expect(f.service.publish(f.input)).rejects.toThrow();
    expect((await f.service.status(f.input.projectRef)).active_release_id).toBeNull();
  }
});

test("prepared interruption revalidates without replacing immutable candidate identity", async () => {
  const f = fixture();
  f.interrupt("prepared");
  await expect(f.service.publish(f.input)).rejects.toThrow("interrupted prepared");
  const path = join(root, f.input.projectRef, ".activation-generations", "_project-release", `${f.input.mutationId}.json`);
  const before = await readFile(path, "utf8");
  await f.service.publish(f.input);
  expect(await readFile(path, "utf8")).toBe(before);
  expect(f.prepareCalls()).toBe(2);
});

test("lost publication response is reconciled without a second preheat or switch", async () => {
  const f = fixture();
  f.interrupt("published");
  await expect(f.service.publish(f.input)).rejects.toThrow("interrupted published");
  const status = await f.service.status(f.input.projectRef, f.input.mutationId);
  expect(status.active_release_id).toBe(f.input.mutationId);
  expect(status.mutation?.status).toBe("outcome_unknown");
  expect((await f.service.publish(f.input)).replayed).toBe(true);
  expect(f.prepareCalls()).toBe(1);
  expect(f.states.get(f.input.mutationId)?.status).toBe("succeeded");
});

test("concurrent publishers on one expected generation have exactly one winner", async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.service.publish(f.input), f.service.publish({ ...f.input, mutationId: crypto.randomUUID() }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
  expect(results.filter((result) => result.status === "rejected").length).toBe(1);
  expect([...f.states.values()].filter((state) => state.status === "failed_terminal").length).toBe(1);
});

test("foreign, tampered and malformed manifests fail closed without legacy fallback", async () => {
  const f = fixture();
  await f.service.publish(f.input);
  const path = join(root, f.input.projectRef, PROJECT_RELEASE_FILE);
  const raw = await readFile(path, "utf8");
  expect(() => parseProjectRelease(raw, "another-tenant")).toThrow("identity");
  const tampered = JSON.parse(raw);
  tampered.members.first.config.version = "2";
  await rm(path);
  await writeFile(path, JSON.stringify(tampered));
  await expect(projectReleaseFunctionManifest(join(root, f.input.projectRef), "first")).rejects.toThrow();
  await expect(edgeFunctionService.getState(f.input.projectRef, "first")).rejects.toThrow();
});

test("duplicate members and incomplete subsequent units are rejected", async () => {
  const f = fixture();
  await expect(f.service.publish({ ...f.input, functions: [f.input.functions[0]!, f.input.functions[0]!] })).rejects.toThrow("Duplicate");
  await f.service.publish(f.input);
  await expect(f.service.publish({
    ...f.input, mutationId: crypto.randomUUID(), expectedReleaseId: f.input.mutationId,
    functions: [f.input.functions[0]!],
  })).rejects.toThrow("all previously enrolled");
});
