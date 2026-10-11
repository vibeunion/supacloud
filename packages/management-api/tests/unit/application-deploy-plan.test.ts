import { expect, test } from "bun:test";
import {
  applicationReleaseId, parseApplicationDeployPlan, type ApplicationReadinessReport,
} from "@supacloud/delivery";
import {
  ApplicationActivationService, type ActivateApplicationInput, type ApplicationActiveRecord,
} from "../../src/services/application-activation";
import { ApplicationDeployPlans, ApplicationDeployPlanError } from "../../src/services/application-deploy-plan";
import type { ApplicationMigrations } from "../../src/services/application-migrations";
import { applicationRuntimePlan } from "../../src/services/application-runtime";
import { projectMutationResourceKey } from "../../src/services/project-mutation.service";
import { stableSha256, stableStringify } from "../../src/utils/stable-json";
import { createApplicationRoutes } from "../../src/routes/applications";
import { runtimeInput } from "../helpers/application-runtime";
import { activationJournal } from "../helpers/application-activation-journal";

const scope = { projectRef: "demo", applicationId: "reviews", environmentId: "test" };
const configurationId = "91234567-89ab-4def-8123-456789abcdef";
const nextConfigurationId = "a1234567-89ab-4def-8123-456789abcdef";
type MigrationReport = Awaited<ReturnType<ApplicationMigrations["inspect"]>>;

async function fixture(active = true) {
  const { journal, states } = activationJournal();
  const input: ActivateApplicationInput = {
    runtime: runtimeInput(), environment: { api: { SETTING: "private-fixture" }, jobs: {} },
    hosts: { api: ["reviews.example.test"] }, configurationId,
    expectedActivationId: null, principal: { type: "project", id: "project:demo" },
  };
  const next = structuredClone(input.runtime.release);
  next.manifest_sha256 = "d".repeat(64);
  next.release_id = applicationReleaseId("demo", "reviews", next.manifest_sha256);
  next.targets[1]!.object_id = "e".repeat(64);
  const calls: string[] = [];
  const state = {
    current: null as ApplicationActiveRecord | null,
    busyAt: 0, idleChecks: 0, activeReads: 0, migrationReads: 0,
    changeAuthority: false, changeJournal: false, changeLedger: false,
    badArtifact: false, badEnvironment: false, badHosts: false, badBun: false, badRoute: false,
    readinessFault: "" as "" | "unhealthy" | "missing" | "foreign" | "kind" | "unit" | "activation" | "replica",
    providerError: false,
  };
  const activation = new ApplicationActivationService({
    mutations: journal,
    readActive: async () => structuredClone(state.current),
    writeActive: async record => { calls.push("write"); state.current = structuredClone(record); },
    confirmActive: async () => { throw new Error("Unexpected confirmation"); },
    checkCompatibility: async () => { calls.push("compatibility"); },
    prepare: async () => { calls.push("prepare"); },
    stop: async () => { calls.push("stop"); },
    start: async () => { calls.push("start"); },
    requireReady: async () => { calls.push("ready"); },
    requireStopped: async () => { calls.push("stopped"); },
    route: async () => { calls.push("route"); }, verifyRoute: async () => {},
  });
  if (active) await activation.activate(input);
  for (const mutation of states.values()) mutation.resourceKey = projectMutationResourceKey({
    type: "application_release", id: stableSha256({ applicationId: "reviews", environmentId: "test" }),
  });
  calls.length = 0;
  const migration: MigrationReport = {
    schema: "supacloud.application-migrations.v1", project_ref: "demo", application_id: "reviews",
    release_id: input.runtime.release.release_id, manifest_sha256: input.runtime.release.manifest_sha256,
    ledger_digest: "f".repeat(64), ledger_compatible: true, project_migrations_applied: true,
    declaration_conflicts: [], targets: [], operator_provisioning: "not-declared",
    compatibility: "not-proven", execution_performed: false, data_recovery: "separate-required",
  };
  const plans = new ApplicationDeployPlans({
    active: { readForApplication: async (ref, app, env) => {
      expect([ref, app, env]).toEqual(["demo", "reviews", "test"]);
      calls.push("read-active");
      if (++state.activeReads > 1 && state.changeAuthority) return null;
      return structuredClone(state.current);
    } },
    mutations: { read: async (ref, id) => {
      calls.push("read-journal"); return journal.read(ref, id);
    } },
    assertIdle: async value => {
      expect(value).toEqual(scope); calls.push("idle");
      if (++state.idleChecks === state.busyAt) throw new ApplicationDeployPlanError("APPLICATION_DEPLOY_PLAN_BUSY", 409);
    },
    releases: { readRelease: async (ref, app, id) => {
      expect([ref, app]).toEqual(["demo", "reviews"]); calls.push("read-release");
      if (state.providerError) throw new Error("private-provider-credential");
      const release = structuredClone(id === next.release_id ? next : input.runtime.release);
      if (state.badArtifact) release.targets[0]!.object_id = "f".repeat(64);
      return release;
    } },
    configurations: { resolve: async (value, id, release) => {
      expect(value).toEqual(scope); calls.push("resolve-configuration");
      expect([configurationId, nextConfigurationId]).toContain(id);
      return {
        environment: Object.fromEntries(release.targets.map((target): [string, Record<string, string>] =>
          [target.name, target.name === "api" ? { SETTING: state.badEnvironment ? "drift" : "private-fixture" } : {}])),
        bunVersion: state.badBun ? "1.0.0" : "1.4.2",
        hosts: { api: [state.badHosts ? "drift.example.test" : "reviews.example.test"] },
      };
    } },
    migrations: { inspect: async (ref, app, id) => {
      expect([ref, app]).toEqual(["demo", "reviews"]); calls.push("inspect-migrations");
      const release = id === next.release_id ? next : input.runtime.release;
      const result = { ...structuredClone(migration), release_id: release.release_id, manifest_sha256: release.manifest_sha256 };
      if (++state.migrationReads > 1 && state.changeLedger) result.ledger_digest = "e".repeat(64);
      return result;
    } },
    verifyRoute: async record => {
      expect(record).toEqual(state.current!); calls.push("verify-route");
      if (state.badRoute) throw new Error("private-route-error");
      if (state.changeJournal) states.get(record.runtime.activationId)!.updatedAt = "2026-10-11T00:00:00.000Z";
    },
    readiness: { inspect: async runtime => {
      calls.push("inspect-readiness");
      const plan = applicationRuntimePlan(runtime);
      const report: ApplicationReadinessReport = {
        project_ref: plan.projectRef, application_id: plan.applicationId, environment_id: plan.environmentId,
        activation_id: plan.activationId, release_id: plan.releaseId, ready: true,
        targets: plan.targets.map(target => ({
          target: target.name, kind: target.kind, unit: target.unit, pid: 123,
          invocation_id: "a".repeat(32), ready: true, code: "READY",
        })),
      };
      switch (state.readinessFault) {
        case "unhealthy": report.ready = false; report.targets[0]!.ready = false; report.targets[0]!.code = "HTTP_NOT_READY"; break;
        case "missing": report.targets.pop(); break;
        case "foreign": report.project_ref = "foreign"; break;
        case "kind": report.targets[0]!.kind = "worker"; break;
        case "unit": report.targets[0]!.unit = "other.service"; break;
        case "activation": report.activation_id = crypto.randomUUID(); break;
        case "replica":
          report.targets[1]!.target = "jobs-r1";
          report.targets[1]!.unit = `supacloud-application-demo-${runtime.activationId}-jobs-r1.service`;
          break;
      }
      return report;
    } },
  });
  return { plans, input, next, state, states, migration, calls, candidate: {
    ...scope, releaseId: input.runtime.release.release_id, configurationId,
  } };
}

test("verified exact candidate is a read-only no-op without secrets or fingerprints", async () => {
  const f = await fixture();
  const before = stableStringify([...f.states]);
  const plan = await f.plans.read(f.candidate);
  expect(parseApplicationDeployPlan(plan)).toEqual(plan);
  expect(plan.action).toBe("no-op");
  expect(plan.current?.activation_id).toBe(f.input.runtime.activationId);
  expect(plan.expected_activation_id).toBe(f.input.runtime.activationId);
  expect(plan.changes).toEqual({ release: false, configuration: false, targets: { added: [], removed: [], changed: [] } });
  expect(plan.compatibility).toBe("not-proven");
  expect(plan.execution_performed).toBe(false);
  expect(f.state.idleChecks).toBe(3);
  expect(stableStringify([...f.states])).toBe(before);
  expect(f.calls.some(call => ["write", "start", "stop", "route", "prepare", "compatibility"].includes(call))).toBe(false);
  expect(JSON.stringify(plan)).not.toContain("private-");
  expect(JSON.stringify(plan)).not.toContain(f.state.current!.configurationDigest);
});

test("first deployment observes absent CAS without inventing a journal or readiness", async () => {
  const f = await fixture(false);
  const plan = await f.plans.read(f.candidate);
  expect(plan.action).toBe("activate");
  expect(plan.current).toBeNull();
  expect(plan.expected_activation_id).toBeNull();
  expect(plan.changes.targets.added).toEqual(["api", "jobs"]);
  expect(f.calls).not.toContain("read-journal");
  expect(f.calls).not.toContain("inspect-readiness");
});

test("changed release/configuration produces exact target diff without activation", async () => {
  const f = await fixture();
  f.next.targets[1]!.name = "tasks";
  f.next.targets[0]!.object_id = "e".repeat(64);
  const plan = await f.plans.read({ ...f.candidate, releaseId: f.next.release_id, configurationId: nextConfigurationId });
  expect(plan.action).toBe("activate");
  expect(plan.changes).toEqual({ release: true, configuration: true,
    targets: { added: ["tasks"], removed: ["jobs"], changed: ["api"] } });
  expect(plan.current?.release_id).toBe(f.input.runtime.release.release_id);
  expect(plan.candidate.release_id).toBe(f.next.release_id);
  expect(plan.expected_activation_id).toBe(f.input.runtime.activationId);
});

test("configuration-only revision is a deployment change even with equivalent values", async () => {
  const f = await fixture();
  const plan = await f.plans.read({ ...f.candidate, configurationId: nextConfigurationId });
  expect(plan.action).toBe("activate");
  expect(plan.changes.release).toBe(false);
  expect(plan.changes.configuration).toBe(true);
});

test.each(["pending", "incompatible", "provisioning"] as const)("same artifact cannot no-op with %s prerequisites", async kind => {
  const f = await fixture();
  if (kind === "pending") f.migration.project_migrations_applied = false;
  if (kind === "incompatible") { f.migration.ledger_compatible = false; f.migration.project_migrations_applied = false; }
  if (kind === "provisioning") f.migration.operator_provisioning = "separate-verification-required";
  expect((await f.plans.read(f.candidate)).action).toBe("activate");
});

test.each([1, 2, 3])("busy on observation checkpoint %i fails closed", async busyAt => {
  const f = await fixture();
  f.state.busyAt = busyAt;
  await expect(f.plans.read(f.candidate)).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_PLAN_BUSY", statusCode: 409 });
});

test.each(["changeAuthority", "changeJournal", "changeLedger"] as const)("detects %s during readback", async fault => {
  const f = await fixture();
  f.state[fault] = true;
  await expect(f.plans.read(f.candidate)).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_PLAN_CHANGED", statusCode: 409 });
});

test.each(["badArtifact", "badEnvironment", "badHosts", "badBun", "badRoute", "providerError"] as const)(
  "refuses unverified %s without disclosing private errors", async fault => {
    const f = await fixture(); f.state[fault] = true;
    await expect(f.plans.read(f.candidate)).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_PLAN_UNVERIFIED", statusCode: 503 });
  },
);

test.each(["unhealthy", "missing", "foreign", "kind", "unit", "activation", "replica"] as const)(
  "binds readiness to exact runtime inventory: %s", async fault => {
    const f = await fixture(); f.state.readinessFault = fault;
    await expect(f.plans.read(f.candidate)).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_PLAN_UNVERIFIED" });
  },
);

test.each(["missing", "failed", "fingerprint", "receipt", "foreign", "resource"] as const)(
  "successful journal proof is mandatory: %s", async fault => {
    const f = await fixture();
    const record = f.states.get(f.input.runtime.activationId)!;
    if (fault === "missing") f.states.delete(f.input.runtime.activationId);
    if (fault === "failed") record.status = "failed_terminal";
    if (fault === "fingerprint") record.requestFingerprint = "f".repeat(64);
    if (fault === "receipt") record.receipt = {};
    if (fault === "foreign") record.projectRef = "foreign";
    if (fault === "resource") record.resourceKey = null;
    await expect(f.plans.read(f.candidate)).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_PLAN_UNVERIFIED" });
  },
);

test.each(["projectRef", "applicationId", "environmentId", "releaseId", "configurationId"] as const)(
  "rejects invalid %s before evidence reads", async field => {
    const f = await fixture();
    await expect(f.plans.read({ ...f.candidate, [field]: "../invalid" })).rejects.toMatchObject({ statusCode: 400 });
    expect(f.calls).toEqual([]);
  },
);

test("migration report is bound to exact candidate and contradictory evidence is rejected", async () => {
  const f = await fixture();
  f.migration.project_ref = "other";
  await expect(f.plans.read(f.candidate)).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_PLAN_UNVERIFIED" });
  f.migration.project_ref = "demo";
  f.migration.ledger_compatible = false;
  await expect(f.plans.read(f.candidate)).rejects.toMatchObject({ code: "APPLICATION_DEPLOY_PLAN_UNVERIFIED" });
});

const url = (releaseId: string, config = configurationId) =>
  `http://localhost/v1/projects/demo/applications/reviews/environments/test/deploy-plan?release_id=${releaseId}&configuration_id=${config}`;

test("authorized GET returns a validated plan without writes", async () => {
  const f = await fixture();
  const app = createApplicationRoutes({ authorize: async () => undefined, projectExists: async () => true, deployPlans: f.plans });
  const response = await app.handle(new Request(url(f.candidate.releaseId)));
  expect(response.status).toBe(200);
  expect(parseApplicationDeployPlan(await response.json()).action).toBe("no-op");
});

test("authorization and project existence precede evidence reads", async () => {
  const f = await fixture();
  const denied = createApplicationRoutes({
    authorize: async () => ({ status: 403, body: { error: "Access denied" } }),
    projectExists: async () => true, deployPlans: f.plans,
  });
  expect((await denied.handle(new Request(url(f.candidate.releaseId)))).status).toBe(403);
  const missing = createApplicationRoutes({
    authorize: async () => undefined, projectExists: async () => false, deployPlans: f.plans,
  });
  expect((await missing.handle(new Request(url(f.candidate.releaseId)))).status).toBe(404);
  expect(f.calls).toEqual([]);
});

test("invalid route query never reads evidence and private provider failures are sanitized", async () => {
  const f = await fixture();
  const app = createApplicationRoutes({ authorize: async () => undefined, projectExists: async () => true, deployPlans: f.plans });
  expect((await app.handle(new Request(url("invalid")))).status).toBe(422);
  expect(f.calls).toEqual([]);
  f.state.providerError = true;
  const response = await app.handle(new Request(url(f.candidate.releaseId)));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    code: "APPLICATION_DEPLOY_PLAN_UNVERIFIED", error: "Application deploy plan is unavailable",
  });
});

test("shared parser refuses forged no-op or unrelated CAS", async () => {
  const f = await fixture();
  const plan = await f.plans.read(f.candidate);
  expect(() => parseApplicationDeployPlan({ ...plan, expected_activation_id: null })).toThrow();
  expect(() => parseApplicationDeployPlan({ ...plan, current: null })).toThrow();
  expect(() => parseApplicationDeployPlan({ ...plan, migrations: { ...plan.migrations, project_migrations_applied: false } })).toThrow();
  expect(() => parseApplicationDeployPlan({ ...plan, private: "must-not-leak" })).toThrow();
});
