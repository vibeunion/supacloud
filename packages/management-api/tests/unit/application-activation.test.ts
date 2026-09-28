import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applicationReleaseId } from "@supacloud/delivery";
import {
  ApplicationActivationService, type ActivateApplicationInput, type ApplicationActivationPorts,
  type ApplicationActiveRecord,
} from "../../src/services/application-activation";
import { ApplicationActiveStorage } from "../../src/services/application-active-storage";
import { runtimeInput } from "../helpers/application-runtime";
import { activationJournal } from "../helpers/application-activation-journal";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "application-activation-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture(operations: ConstructorParameters<typeof ApplicationActiveStorage>[1] = {}) {
  const { journal, states } = activationJournal();
  const storage = new ApplicationActiveStorage(join(root, "authority"), operations);
  const calls: string[] = [];
  let routed: ApplicationActiveRecord | null = null;
  const ports: ApplicationActivationPorts = {
    mutations: journal,
    readActive: runtime => storage.read(runtime),
    writeActive: async (record, previous) => { calls.push("commit"); await storage.write(record, previous); },
    confirmActive: async record => { await storage.confirm(record); calls.push("confirm"); },
    checkCompatibility: async () => { calls.push("compatibility"); },
    prepare: async () => { calls.push("prepare"); },
    stop: async () => { calls.push("stop"); },
    start: async () => { calls.push("start"); },
    requireReady: async () => { calls.push("ready"); },
    requireStopped: async () => { calls.push("stopped"); },
    route: async record => { calls.push("route"); routed = record; },
    verifyRoute: async record => {
      calls.push("verify-route");
      if (routed?.runtime.activationId !== record.runtime.activationId) throw new Error("route mismatch");
    },
  };
  const input: ActivateApplicationInput = {
    runtime: runtimeInput(), environment: { api: { EXAMPLE: "private-config-fixture" }, jobs: {} },
    expectedActivationId: null, principal: { type: "project", id: "project:demo" },
  };
  return { ports, storage, calls, states, input, service: new ApplicationActivationService(ports) };
}

function recovery(input: ActivateApplicationInput) {
  return {
    projectRef: input.runtime.release.project_ref, applicationId: input.runtime.release.application_id,
    environmentId: input.runtime.environmentId, activationId: input.runtime.activationId, principal: input.principal,
  };
}

test("activation journals each phase and commits only after readiness and route readback", async () => {
  const f = fixture();
  const result = await f.service.activate(f.input);
  expect(result).toMatchObject({ activation_id: f.input.runtime.activationId, replayed: false });
  expect(f.calls).toEqual(["compatibility", "prepare", "start", "ready", "route", "verify-route", "commit", "ready", "verify-route"]);
  const state = f.states.get(f.input.runtime.activationId)!;
  expect(state.status).toBe("succeeded");
  expect(state.checkpoint.phase).toBe("committed");
  expect(JSON.stringify(state)).not.toContain("private-config-fixture");
  const reopened = new ApplicationActiveStorage(join(root, "authority"));
  expect((await reopened.read(f.input.runtime))?.runtime.activationId).toBe(f.input.runtime.activationId);
  f.calls.length = 0;
  expect((await f.service.activate(f.input)).replayed).toBe(true);
  expect(f.calls).toEqual(["ready", "verify-route"]);
});

test("upgrade and explicit application rollback use new activation IDs without executing data recovery", async () => {
  const f = fixture();
  await f.service.activate(f.input);
  const upgraded = structuredClone(f.input);
  upgraded.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
  upgraded.runtime.release.manifest_sha256 = "d".repeat(64);
  upgraded.runtime.release.release_id = applicationReleaseId("demo", "reviews", upgraded.runtime.release.manifest_sha256);
  upgraded.expectedActivationId = f.input.runtime.activationId;
  f.calls.length = 0;
  await f.service.activate(upgraded);
  expect(f.calls.indexOf("stop")).toBeLessThan(f.calls.indexOf("start"));
  const rollback = structuredClone(f.input);
  rollback.runtime.activationId = "21234567-89ab-4def-8123-456789abcdef";
  rollback.expectedActivationId = upgraded.runtime.activationId;
  await f.service.activate(rollback);
  expect((await f.storage.read(rollback.runtime))?.runtime.release.release_id).toBe(f.input.runtime.release.release_id);
  expect([...f.states.values()].every(state => state.status === "succeeded")).toBe(true);
});

test("revision conflict and compatibility rejection cannot start or route a candidate", async () => {
  const f = fixture();
  f.input.expectedActivationId = "11234567-89ab-4def-8123-456789abcdef";
  await expect(f.service.activate(f.input)).rejects.toThrow("REVISION_CONFLICT");
  expect(f.calls).toEqual([]);
  const other = fixture();
  other.ports.checkCompatibility = async () => { throw new Error("incompatible migration"); };
  await expect(other.service.activate(other.input)).rejects.toThrow("incompatible migration");
  expect(other.calls).toEqual([]);
  expect(other.states.get(other.input.runtime.activationId)!.status).toBe("failed_terminal");
});

test("a post-routing failure preserves unknown outcome and never retries or automatically rolls back", async () => {
  const f = fixture();
  f.ports.writeActive = async () => { throw new Error("disk unavailable"); };
  await expect(f.service.activate(f.input)).rejects.toThrow("disk unavailable");
  const state = f.states.get(f.input.runtime.activationId)!;
  expect(state.status).toBe("outcome_unknown");
  expect(state.checkpoint.phase).toBe("routed");
  const calls = [...f.calls];
  await expect(f.service.activate(f.input)).rejects.toThrow("OUTCOME_UNRESOLVED");
  expect(f.calls).toEqual(calls);
  expect(await f.storage.read(f.input.runtime)).toBeNull();
});

test("failed worker readiness never exposes the new release or marks the journal successful", async () => {
  const f = fixture();
  f.ports.requireReady = async () => { throw new Error("worker not ready"); };
  await expect(f.service.activate(f.input)).rejects.toThrow("worker not ready");
  expect(f.calls).toEqual(["compatibility", "prepare", "start"]);
  expect(f.states.get(f.input.runtime.activationId)!.checkpoint.phase).toBe("started");
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
  expect(await f.storage.read(f.input.runtime)).toBeNull();
});

test("interrupted runtime transitions require reconciliation before any effect can replay", async () => {
  const f = fixture();
  f.ports.start = async () => { throw new Error("interrupted"); };
  await expect(f.service.activate(f.input)).rejects.toThrow("interrupted");
  f.states.get(f.input.runtime.activationId)!.status = "running";
  f.calls.length = 0;
  await expect(f.service.activate(f.input)).rejects.toThrow("RECONCILIATION_REQUIRED");
  expect(f.calls).toEqual([]);
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
});

test("legal target names cannot become forbidden journal projection keys", async () => {
  const f = fixture();
  f.input.runtime.release.targets[0]!.name = "token";
  f.input.runtime.ports = { token: 31000 };
  f.input.environment = { token: {}, jobs: {} };
  f.input.hosts = { token: ["reviews.example.test"] };
  await f.service.activate(f.input);
  const desired = f.states.get(f.input.runtime.activationId)!.checkpoint.desired as {
    runtime: { ports: unknown };
  };
  expect(desired.runtime.ports).toEqual([{ target: "token", port: 31000 }]);
  expect(f.states.get(f.input.runtime.activationId)!.checkpoint.desired).toHaveProperty("hosts", [
    { target: "token", hosts: ["reviews.example.test"] },
  ]);
  expect((await f.service.reconcile(recovery(f.input))).replayed).toBe(true);
  const changed = structuredClone(f.input);
  changed.hosts = { token: ["changed.example.test"] };
  await expect(f.service.activate(changed)).rejects.toThrow("mutation conflict");
});

test("recovery confirms a committed authority after receipt failure without replaying effects or requiring secrets", async () => {
  const f = fixture();
  f.ports.mutations!.success = async () => { throw new Error("receipt unavailable"); };
  await expect(f.service.activate(f.input)).rejects.toThrow("receipt unavailable");
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
  f.calls.length = 0;
  expect((await f.service.reconcile(recovery(f.input))).replayed).toBe(true);
  expect(f.calls).toEqual(["confirm", "ready", "verify-route", "ready", "verify-route"]);
  const state = f.states.get(f.input.runtime.activationId)!;
  expect(state.status).toBe("succeeded");
  expect(state.receipt).toHaveProperty("reconciliation");
  expect(JSON.stringify(state.receipt)).not.toContain("private-config-fixture");
  f.calls.length = 0;
  expect((await f.service.activate(f.input)).replayed).toBe(true);
  expect(f.calls).toEqual(["ready", "verify-route"]);
});

test("recovery refuses uncommitted authority and early runtime transitions", async () => {
  const f = fixture();
  f.ports.writeActive = async () => { throw new Error("authority unavailable"); };
  await expect(f.service.activate(f.input)).rejects.toThrow("authority unavailable");
  f.calls.length = 0;
  await expect(f.service.reconcile(recovery(f.input))).rejects.toThrow("READBACK_MISMATCH");
  expect(f.calls).toEqual([]);
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
  const early = fixture();
  early.input.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
  early.ports.start = async () => { throw new Error("start unknown"); };
  await expect(early.service.activate(early.input)).rejects.toThrow("start unknown");
  await expect(early.service.reconcile(recovery(early.input))).rejects.toThrow("OBSERVATION_REQUIRED");
});

test("recovery checks principal, environment and checkpoint fingerprint before observation", async () => {
  const f = fixture();
  f.ports.mutations!.success = async () => { throw new Error("receipt unavailable"); };
  await expect(f.service.activate(f.input)).rejects.toThrow();
  f.calls.length = 0;
  await expect(f.service.reconcile({ ...recovery(f.input), principal: { type: "project", id: "other" } }))
    .rejects.toThrow("IDENTITY_MISMATCH");
  await expect(f.service.reconcile({ ...recovery(f.input), environmentId: "production" }))
    .rejects.toThrow("IDENTITY_MISMATCH");
  f.states.get(f.input.runtime.activationId)!.requestFingerprint = "f".repeat(64);
  await expect(f.service.reconcile(recovery(f.input))).rejects.toThrow("CHECKPOINT_INVALID");
  expect(f.calls).toEqual([]);
});

test("recovery requires the previous activation stopped and the desired activation ready", async () => {
  const f = fixture();
  await f.service.activate(f.input);
  const next = structuredClone(f.input);
  next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
  next.expectedActivationId = f.input.runtime.activationId;
  f.ports.mutations!.success = async () => { throw new Error("receipt unavailable"); };
  await expect(f.service.activate(next)).rejects.toThrow();
  f.calls.length = 0;
  f.ports.requireStopped = async () => { throw new Error("old worker running"); };
  await expect(f.service.reconcile(recovery(next))).rejects.toThrow("old worker running");
  expect(f.calls).toEqual([]);
  f.ports.requireStopped = async () => { f.calls.push("stopped"); };
  const ready = f.ports.requireReady;
  f.ports.requireReady = async () => { throw new Error("not ready"); };
  await expect(f.service.reconcile(recovery(next))).rejects.toThrow("not ready");
  expect(f.states.get(next.runtime.activationId)!.status).toBe("outcome_unknown");
  f.ports.requireReady = ready;
  f.calls.length = 0;
  await f.service.reconcile(recovery(next));
  expect(f.calls).toEqual(["stopped", "confirm", "ready", "verify-route", "stopped", "ready", "verify-route"]);
});

test("an authority changed during observation never receives a recovery receipt", async () => {
  const f = fixture();
  f.ports.mutations!.success = async () => { throw new Error("receipt unavailable"); };
  await expect(f.service.activate(f.input)).rejects.toThrow();
  f.ports.requireReady = async () => {
    const current = (await f.storage.read(f.input.runtime))!;
    const next = structuredClone(current);
    next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
    await f.storage.write(next, current.runtime.activationId);
  };
  await expect(f.service.reconcile(recovery(f.input))).rejects.toThrow("READBACK_MISMATCH");
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
});

test("replay rejects a recovery receipt not bound to the desired immutable configuration", async () => {
  const f = fixture();
  f.ports.mutations!.success = async () => { throw new Error("receipt unavailable"); };
  await expect(f.service.activate(f.input)).rejects.toThrow();
  await f.service.reconcile(recovery(f.input));
  const receipt = f.states.get(f.input.runtime.activationId)!.receipt!;
  (receipt.reconciliation as Record<string, unknown>).evidence_fingerprint = "f".repeat(64);
  await expect(f.service.activate(f.input)).rejects.toThrow("RECEIPT_INVALID");
  await expect(f.service.reconcile(recovery(f.input))).rejects.toThrow("RECEIPT_INVALID");
});

test("readable authority after rename cannot recover until directory durability is confirmed", async () => {
  let failSync = true;
  const f = fixture({ beforeDirectorySync: async () => {
    if (failSync) throw new Error("directory fsync unavailable");
  } });
  await expect(f.service.activate(f.input)).rejects.toThrow("directory fsync unavailable");
  const before = await f.storage.read(f.input.runtime);
  expect(before?.runtime.activationId).toBe(f.input.runtime.activationId);
  expect(f.states.get(f.input.runtime.activationId)!.checkpoint.phase).toBe("routed");
  f.calls.length = 0;
  await expect(f.service.reconcile(recovery(f.input))).rejects.toThrow("directory fsync unavailable");
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
  expect(f.calls).toEqual([]);
  failSync = false;
  await f.service.reconcile(recovery(f.input));
  expect(await f.storage.read(f.input.runtime)).toEqual(before);
  expect(f.calls).toEqual(["confirm", "ready", "verify-route", "ready", "verify-route"]);
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("succeeded");
});

test("recovery rejects checkpoint hosts that no longer match the original request fingerprint", async () => {
  const f = fixture();
  f.input.hosts = { api: ["reviews.example.test"] };
  f.ports.mutations!.success = async () => { throw new Error("receipt unavailable"); };
  await expect(f.service.activate(f.input)).rejects.toThrow("receipt unavailable");
  const state = f.states.get(f.input.runtime.activationId)!;
  const desired = state.checkpoint.desired as Record<string, unknown>;
  desired.hosts = [{ target: "api", hosts: ["different.example.test"] }];
  f.calls.length = 0;
  await expect(f.service.reconcile(recovery(f.input))).rejects.toThrow("CHECKPOINT_INVALID");
  expect(f.calls).toEqual([]);
  expect(state.status).toBe("outcome_unknown");
});
