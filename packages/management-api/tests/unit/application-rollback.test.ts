import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { applicationReleaseId, ApplicationRollbackSnapshotSchema } from "@supacloud/delivery";
import {
  ApplicationActivationService, type ActivateApplicationInput, type ApplicationActiveRecord,
} from "../../src/services/application-activation";
import { ApplicationRollbackSnapshots, ApplicationRollbackError } from "../../src/services/application-rollback";
import { projectMutationResourceKey } from "../../src/services/project-mutation.service";
import { stableSha256, stableStringify } from "../../src/utils/stable-json";
import { createApplicationRoutes } from "../../src/routes/applications";
import { runtimeInput } from "../helpers/application-runtime";
import { activationJournal } from "../helpers/application-activation-journal";

const scope = { projectRef: "demo", applicationId: "reviews", environmentId: "test" };
const oldConfiguration = "91234567-89ab-4def-8123-456789abcdef";
const newConfiguration = "a1234567-89ab-4def-8123-456789abcdef";

async function fixture(upgrade = true) {
  const { journal, states } = activationJournal();
  const input: ActivateApplicationInput = {
    runtime: runtimeInput(), environment: { api: { SETTING: "private-old-fixture" }, jobs: {} },
    hosts: { api: ["reviews.example.test"] }, configurationId: oldConfiguration,
    expectedActivationId: null, principal: { type: "project", id: "project:demo" },
  };
  const next = structuredClone(input);
  next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
  next.runtime.release.manifest_sha256 = "d".repeat(64);
  next.runtime.release.release_id = applicationReleaseId("demo", "reviews", next.runtime.release.manifest_sha256);
  next.runtime.ports = { api: 31001 };
  next.environment = { api: { SETTING: "private-new-fixture" }, jobs: {} };
  next.configurationId = newConfiguration;
  next.expectedActivationId = input.runtime.activationId;
  const calls: string[] = [];
  const state = {
    current: null as ApplicationActiveRecord | null,
    routed: null as ApplicationActiveRecord | null,
    idleChecks: 0,
    busy: false, becomeBusy: false, becomeBusyOnReadback: false, activeReads: 0,
    changeAuthority: false, changeJournal: false,
    badRelease: false, badEnvironment: false, badHosts: false, badBun: false,
  };
  const activation = new ApplicationActivationService({
    mutations: journal,
    readActive: async () => structuredClone(state.current),
    writeActive: async (record, expected) => {
      if ((state.current?.runtime.activationId ?? null) !== expected) throw new Error("REVISION_CONFLICT");
      calls.push("write-active"); state.current = structuredClone(record);
    },
    confirmActive: async () => { throw new Error("Unexpected durability mutation"); },
    checkCompatibility: async () => { calls.push("compatibility"); },
    prepare: async () => { calls.push("prepare"); },
    stop: async () => { calls.push("stop"); },
    start: async () => { calls.push("start"); },
    requireReady: async () => { calls.push("ready"); },
    requireStopped: async () => { calls.push("stopped"); },
    route: async record => { calls.push("route"); state.routed = structuredClone(record); },
    verifyRoute: async record => {
      if (!state.routed) throw new Error("Route not installed");
      expect(record).toEqual(state.routed);
    },
  });
  await activation.activate(input);
  if (upgrade) await activation.activate(next);
  // 现有测试桩保存资源 id；快照验证使用生产账本的规范 resource key。
  for (const mutation of states.values()) {
    mutation.resourceKey = projectMutationResourceKey({
      type: "application_release", id: stableSha256({ applicationId: "reviews", environmentId: "test" }),
    });
  }
  calls.length = 0;
  const snapshots = new ApplicationRollbackSnapshots({
    active: { readForApplication: async (ref, app, environment) => {
      expect([ref, app, environment]).toEqual(["demo", "reviews", "test"]);
      state.activeReads++;
      if (state.becomeBusyOnReadback && state.activeReads > 1) state.busy = true;
      calls.push("read-active"); return structuredClone(state.current);
    } },
    mutations: { read: async (ref, id) => {
      expect(ref).toBe("demo"); calls.push(`journal:${id}`); return journal.read(ref, id);
    } },
    assertIdle: async value => {
      expect(value).toEqual(scope);
      state.idleChecks++;
      if (state.busy || (state.becomeBusy && state.idleChecks > 1)) {
        throw new ApplicationRollbackError("APPLICATION_ROLLBACK_BUSY", 409);
      }
    },
    releases: { readRelease: async (ref, app, id) => {
      expect([ref, app]).toEqual(["demo", "reviews"]);
      calls.push(`release:${id}`);
      const release = structuredClone(id === input.runtime.release.release_id ? input.runtime.release : next.runtime.release);
      if (state.badRelease) release.created_at = "2026-09-01T00:00:00.000Z";
      return release;
    } },
    configurations: { resolve: async (value, id, release) => {
      expect(value).toEqual(scope); calls.push(`configuration:${id}`);
      const source = id === oldConfiguration ? input : next;
      expect(release).toEqual(source.runtime.release);
      return {
        environment: state.badEnvironment ? { api: {}, jobs: {} }
          : Object.fromEntries(Object.entries(source.environment).map(([name, values]) => [name, { ...values }])),
        hosts: state.badHosts ? { api: ["other.example.test"] }
          : Object.fromEntries(Object.entries(source.hosts!).map(([name, hosts]) => [name, [...hosts]])),
        bunVersion: state.badBun ? "1.0.0" : "1.4.3",
      };
    } },
    verifyRoute: async record => {
      calls.push("verify-route");
      if (!state.routed) throw new Error("Route not installed");
      expect(record).toEqual(state.routed);
      if (state.changeAuthority) state.current = { ...record, runtime: { ...record.runtime, activationId: crypto.randomUUID() } };
      if (state.changeJournal) states.get(record.runtime.activationId)!.updatedAt = "2026-10-11T00:00:00.000Z";
    },
  });
  return { snapshots, state, states, calls, input, next };
}

test("journal selects exact previous release/configuration without mutations or secrets", async () => {
  const f = await fixture();
  const before = stableStringify([...f.states]);
  const snapshot = await f.snapshots.read(scope);
  expect(Value.Check(ApplicationRollbackSnapshotSchema, snapshot)).toBe(true);
  expect(snapshot).toEqual({
    schema: "supacloud.application-rollback-snapshot.v1",
    project_ref: "demo", application_id: "reviews", environment_id: "test",
    active: { release_id: f.next.runtime.release.release_id, activation_id: f.next.runtime.activationId, configuration_id: newConfiguration },
    previous: { release_id: f.input.runtime.release.release_id, activation_id: f.input.runtime.activationId, configuration_id: oldConfiguration },
  });
  expect(f.state.idleChecks).toBe(3);
  expect(stableStringify([...f.states])).toBe(before);
  expect(f.calls.some(call => ["start", "stop", "route", "prepare", "compatibility", "write-active"].includes(call))).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain("private-");
  expect(f.calls.filter(call => call.startsWith("release:"))).toEqual([
    `release:${f.next.runtime.release.release_id}`, `release:${f.input.runtime.release.release_id}`,
  ]);
});

test("initial and absent authority never invent a previous activation", async () => {
  const initial = await fixture(false);
  expect((await initial.snapshots.read(scope)).previous).toBeNull();
  const absent = await fixture();
  absent.state.current = null;
  const snapshot = await absent.snapshots.read(scope);
  expect(snapshot.active).toBeNull();
  expect(snapshot.previous).toBeNull();
  expect(absent.calls).toEqual(["read-active", "read-active"]);
});

test.each(["busy", "becomeBusy", "becomeBusyOnReadback", "changeAuthority", "changeJournal", "badRelease", "badEnvironment", "badHosts", "badBun"] as const)(
  "fails closed on %s without performing rollback", async fault => {
    const f = await fixture();
    f.state[fault] = true;
    await expect(f.snapshots.read(scope)).rejects.toBeInstanceOf(ApplicationRollbackError);
    expect(f.calls.some(call => ["start", "stop", "route", "write-active"].includes(call))).toBe(false);
  },
);

test("successful authority reconciliation remains valid rollback selection evidence", async () => {
  const f = await fixture();
  const current = f.states.get(f.next.runtime.activationId)!;
  current.checkpoint.phase = "routed";
  const reconciliation = {
    source: "project.release.authority", observed_at: "2026-10-11T00:00:00.000Z",
    evidence_code: "RELEASE_AUTHORITY_CONFIRMED",
    evidence_fingerprint: stableSha256({ schema: "supacloud.application-activation-recovery.v1", desired: f.state.current }),
    target_status: "succeeded",
  };
  current.receipt = { reconciliation };
  expect((await f.snapshots.read(scope)).previous?.activation_id).toBe(f.input.runtime.activationId);
  current.receipt = { reconciliation: { ...reconciliation, evidence_fingerprint: "f".repeat(64) } };
  await expect(f.snapshots.read(scope)).rejects.toMatchObject({ code: "APPLICATION_ROLLBACK_UNVERIFIED" });
});

test.each(["foreign", "failed", "receipt"] as const)("previous journal must also have trustworthy %s evidence", async fault => {
  const f = await fixture();
  const previous = f.states.get(f.input.runtime.activationId)!;
  if (fault === "foreign") previous.projectRef = "other";
  if (fault === "failed") previous.status = "failed_terminal";
  if (fault === "receipt") previous.receipt = {};
  await expect(f.snapshots.read(scope)).rejects.toMatchObject({ code: "APPLICATION_ROLLBACK_UNVERIFIED" });
});

test.each(["missing-current", "missing-previous", "operation", "resource", "fingerprint", "phase", "receipt", "foreign", "failed"] as const)(
  "requires trustworthy activation evidence: %s", async fault => {
    const f = await fixture();
    const current = f.states.get(f.next.runtime.activationId)!;
    switch (fault) {
      case "missing-current": f.states.delete(f.next.runtime.activationId); break;
      case "missing-previous": f.states.delete(f.input.runtime.activationId); break;
      case "operation": current.operation = "other.operation"; break;
      case "resource": current.resourceKey = null; break;
      case "fingerprint": current.requestFingerprint = "f".repeat(64); break;
      case "phase": current.checkpoint.phase = "prepared"; break;
      case "receipt": current.receipt = { private: "must-not-escape" }; break;
      case "foreign": current.projectRef = "other"; break;
      case "failed": current.status = "failed_terminal"; break;
    }
    await expect(f.snapshots.read(scope)).rejects.toMatchObject({ code: "APPLICATION_ROLLBACK_UNVERIFIED", statusCode: 503 });
  },
);

test("snapshot does not expose a target after unverified direct authority editing", async () => {
  const f = await fixture();
  f.state.current!.configurationId = oldConfiguration;
  await expect(f.snapshots.read(scope)).rejects.toMatchObject({ code: "APPLICATION_ROLLBACK_UNVERIFIED" });
});

test("invalid scope is rejected before reads", async () => {
  const f = await fixture();
  await expect(f.snapshots.read({ ...scope, projectRef: "../other" })).rejects.toMatchObject({ statusCode: 400 });
  expect(f.calls).toEqual([]);
});

test("authorized route returns only the validated snapshot and remains inert", async () => {
  const f = await fixture();
  const app = createApplicationRoutes({
    projectExists: async () => true, authorize: async () => undefined, rollback: f.snapshots,
  });
  const response = await app.handle(new Request("http://localhost/v1/projects/demo/applications/reviews/environments/test/rollback-snapshot"));
  expect(response.status).toBe(200);
  expect(Value.Check(ApplicationRollbackSnapshotSchema, await response.json())).toBe(true);
  expect(f.calls.some(call => ["start", "stop", "write-active"].includes(call))).toBe(false);
});

test("snapshot authorization precedes any evidence read", async () => {
  let reads = 0;
  const app = createApplicationRoutes({
    projectExists: async () => true,
    authorize: async () => ({ status: 403, body: { error: "Access denied" } }),
    rollback: { read: async () => { reads++; throw new Error("Unexpected read"); } },
  });
  const response = await app.handle(new Request("http://localhost/v1/projects/demo/applications/reviews/environments/test/rollback-snapshot"));
  expect(response.status).toBe(403);
  expect(reads).toBe(0);
});

test("snapshot route never reflects private provider errors", async () => {
  const f = await fixture();
  f.state.badRelease = true;
  const app = createApplicationRoutes({
    projectExists: async () => true, authorize: async () => undefined, rollback: f.snapshots,
  });
  const response = await app.handle(new Request("http://localhost/v1/projects/demo/applications/reviews/environments/test/rollback-snapshot"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    code: "APPLICATION_ROLLBACK_UNVERIFIED", error: "Application rollback snapshot is unavailable",
  });
});
