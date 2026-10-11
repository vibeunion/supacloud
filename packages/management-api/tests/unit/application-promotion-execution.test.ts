import { expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  applicationReleaseId, applicationPromotionAction, applicationPromotionSteps, applicationPromotionPlanDigest,
  deriveDeploymentEvidenceStatus, parseApplicationPromotionPlan,
  type ApplicationPromotionPlanContent, type DeploymentEvidence, type DeliveryMigrationArchive,
} from "@supacloud/delivery";
import {
  ApplicationActivationService, hasApplicationPromotionActivationReceipt,
  type ApplicationActivationMutations, type ApplicationActivationPorts, type ApplicationActiveRecord,
} from "../../src/services/application-activation";
import { ApplicationPromotionExecutor, type ApplicationPromotionExecutorDependencies } from "../../src/services/application-promotion-executor";
import { ApplicationPromotionReconciler } from "../../src/services/application-promotion-reconciler";
import {
  ApplicationPromotions, ApplicationPromotionError, type ApplicationPromotionDependencies,
} from "../../src/services/application-promotion";
import { assertApplicationPromotionReconciliation } from "../../src/services/application-promotion-ownership";
import { applicationRuntimePlan } from "../../src/services/application-runtime";
import {
  applicationPromotionFingerprint, applicationPromotionResource, parseApplicationPromotionCheckpoint,
  type ApplicationPromotionCheckpoint, type ApplicationPromotionRequest,
} from "../../src/services/application-promotion-operation";
import {
  assertPublicMutationPayload, projectMutationResourceKey,
  type ProjectMutationState, type MutationLeaseInput,
} from "../../src/services/project-mutation.service";
import { ApplicationMigrations } from "../../src/services/application-migrations";
import { calculateMigrationChecksum } from "../../src/services/migration-promotion";
import type { LogicalBackupIdentity } from "../../src/types/backup";
import { createApplicationRoutes } from "../../src/routes/applications";
import { createApplicationSmokeVerifier } from "../../src/services/application-smoke";
import { stableSha256, stableStringify } from "../../src/utils/stable-json";
import { runtimeInput } from "../helpers/application-runtime";

const parentId = "41234567-89ab-4def-8123-456789abcdef";
const configurationId = "51234567-89ab-4def-8123-456789abcdef";
const now = Date.parse("2026-10-11T04:00:00.000Z");
const stamp = new Date(now).toISOString();

function fixture(migrationSql?: string) {
  const runtime = { ...runtimeInput(), bunVersion: "1.4.2" };
  const migration = {
    version: "1", name: "promotion_fixture", sql: migrationSql ?? "",
    path: "migrations/project-migration/1_promotion_fixture.sql",
    bytes: Buffer.byteLength(migrationSql ?? ""), sha256: stableSha256(migrationSql ?? ""),
    executor: "project-migration" as const,
  };
  const ledger: Array<{ version: string; name: string; checksum: string; statements: string[];
    statement_count: number; applied_at: null }> = [];
  const ledgerDigest = () => stableSha256(ledger.map(({ version, name, checksum }) => ({ version, name, checksum })));
  const sourceReleaseId = applicationReleaseId("staging", "reviews", runtime.release.manifest_sha256);
  const content: ApplicationPromotionPlanContent = {
    schema: "supacloud.application-promotion-plan.v1",
    project_ref: "demo", application_id: "reviews", environment_id: "test",
    manifest_sha256: runtime.release.manifest_sha256,
    source: {
      project_ref: "staging", environment_id: "staging", release_id: sourceReleaseId,
      activation_id: "61234567-89ab-4def-8123-456789abcdef",
      receipt_confirmed: true, ready: true, smoke_verified: true,
      evidence_sha256: "e".repeat(64), migration_ledger_digest: stableSha256([]),
    },
    target: {
      candidate_release_id: runtime.release.release_id, current_release_id: null,
      artifact_action: "materialize", configuration_id: configurationId,
      configuration: {
        schema: "supacloud.application-configuration.v1", project_ref: "demo",
        application_id: "reviews", environment_id: "test", configuration_id: configurationId,
        created_at: stamp, bun_version: "1.4.2",
        targets: [
          { name: "api", kind: "http", hosts: ["reviews.example.test"], environment_names: ["APP_SETTING"] },
          { name: "jobs", kind: "worker", hosts: [], environment_names: [] },
        ],
      },
      activation_id: null, receipt_confirmed: false, ready: false, smoke_verified: false,
      evidence_sha256: null, migration_ledger_digest: null,
    },
    migrations: {
      ledger_digest: stableSha256([]), ledger_compatible: true, project_migrations_applied: !migrationSql,
      pending_versions: migrationSql ? ["1"] : [], operator_provisioning_required: false,
    },
    backup: { required: !!migrationSql, confirmed: false },
    action: "promote", blockers: migrationSql ? ["MIGRATION_PENDING", "BACKUP_REQUIRED"] : [],
    steps: [],
    execution_performed: false, data_recovery: "separate-required",
  };
  const makePlan = (value: ApplicationPromotionPlanContent) => {
    value.action = applicationPromotionAction(value);
    value.steps = applicationPromotionSteps(value);
    return parseApplicationPromotionPlan({ ...value, plan_sha256: applicationPromotionPlanDigest(value) });
  };
  const plan = makePlan(structuredClone(content));
  const request: ApplicationPromotionRequest = {
    project_ref: "demo", application_id: "reviews", environment_id: "test",
    source_ref: "staging", source_environment_id: "staging", source_release_id: sourceReleaseId,
    configuration_id: configurationId, plan_sha256: plan.plan_sha256, approved_migration_digest: null,
  };
  const lease: MutationLeaseInput = {
    projectRef: "demo", mutationId: parentId,
    leaseToken: "71234567-89ab-4def-8123-456789abcdef", fencingEpoch: 3,
  };
  const state: ProjectMutationState = {
    projectRef: "demo", mutationId: parentId, operation: "application.release.promote",
    resourceKey: projectMutationResourceKey(applicationPromotionResource("reviews", "test")),
    requestFingerprint: applicationPromotionFingerprint(request), principal: { type: "admin", id: "release-admin" },
    status: "running", checkpoint: {}, receipt: null, responseStatus: null, failureCode: null,
    leaseOwner: "fixture", leaseExpiresAt: "2099-01-01T00:00:00.000Z", fencingEpoch: 3,
    completedAt: null, createdAt: stamp, updatedAt: stamp,
  };
  const owner = { lease, principal: state.principal, requestFingerprint: state.requestFingerprint };
  const initial: ApplicationPromotionCheckpoint = {
    schema: "supacloud.application-promotion-operation.v1", phase: "activating", plan, request, mutation_id: parentId,
    backup_id: `logical-full_demo_${"a".repeat(32)}`, activation_id: runtime.activationId,
    migration: { before_ledger_digest: plan.migrations.ledger_digest, after_ledger_digest: plan.migrations.ledger_digest },
  };
  let expired = false;
  let active: ApplicationActiveRecord | null = null;
  let persisted: DeploymentEvidence | null = null;
  let failAt: string | undefined;
  const calls: string[] = [];
  const phases: string[] = [];
  let transactionOpen = false;
  let queued = Promise.resolve();
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!transactionOpen) throw new Error("SQL escaped transaction");
    const text = strings.join("?").replaceAll(/\s+/g, " ");
    if (text.includes("SELECT mutation_id")) {
      return !expired && state.status === "running" && values[0] === state.projectRef
        && values[1] === state.mutationId && values[2] === lease.leaseToken && values[3] === state.fencingEpoch
        ? [{ mutation_id: parentId }] : [];
    }
    if (text.includes("UPDATE project_mutations")) {
      const next = values[0];
      assertPublicMutationPayload(next);
      if (expired || state.status !== "running") return [];
      state.checkpoint = structuredClone(next);
      const attempt = next["activation"];
      if (attempt && typeof attempt === "object" && "checkpoint" in attempt
        && attempt.checkpoint && typeof attempt.checkpoint === "object" && "phase" in attempt.checkpoint) {
        phases.push(String(attempt.checkpoint.phase));
      }
      return [{ mutation_id: parentId }];
    }
    return [{
      project_ref: state.projectRef, mutation_id: state.mutationId, operation: state.operation,
      resource_key: state.resourceKey, request_fingerprint: state.requestFingerprint,
      principal_type: state.principal.type, principal_id: state.principal.id,
      status: state.status, checkpoint: structuredClone(state.checkpoint), receipt: state.receipt,
      response_status: state.responseStatus, failure_code: state.failureCode, lease_owner: state.leaseOwner,
      lease_expires_at: state.leaseExpiresAt, fencing_epoch: state.fencingEpoch, completed_at: state.completedAt,
      created_at: state.createdAt, updated_at: state.updatedAt,
    }];
  };
  const database = Object.assign(query, {
    async begin<T>(action: (transaction: SQL) => Promise<T>): Promise<T> {
      const previous = queued;
      const turn = Promise.withResolvers<void>();
      queued = turn.promise;
      await previous;
      const saved = structuredClone(state.checkpoint);
      transactionOpen = true;
      try { return await action(query as unknown as SQL); }
      catch (error) { state.checkpoint = saved; throw error; }
      finally { transactionOpen = false; turn.resolve(); }
    },
  }) as unknown as SQL;
  const effect = async (name: string) => {
    calls.push(name);
    if (failAt === name) throw new Error("private-provider-error");
  };
  const mutations: ApplicationActivationMutations = {
    async begin(input) {
      await effect("begin");
      if (input.requestFingerprint !== state.requestFingerprint
        || input.operation !== state.operation || input.projectRef !== state.projectRef
        || input.mutationId !== parentId || stableStringify(input.principal) !== stableStringify(state.principal)
        || !input.resource || projectMutationResourceKey(input.resource) !== state.resourceKey) throw new Error("request conflict");
      return state.status === "running" ? { state: structuredClone(state), lease } : { state: structuredClone(state) };
    },
    async checkpoint(value, checkpoint) {
      if (expired || value.fencingEpoch !== state.fencingEpoch) throw new Error("lease lost");
      assertPublicMutationPayload(checkpoint);
      await effect(`checkpoint:${checkpoint["phase"]}`);
      state.checkpoint = structuredClone(checkpoint);
    },
    async protect(value, action) {
      if (expired || state.status !== "running" || value.fencingEpoch !== state.fencingEpoch) throw new Error("lease lost");
      await action();
    },
    async success(_lease, receipt) {
      await effect("success");
      Object.assign(state, { status: "succeeded", receipt, responseStatus: 200 });
    },
    async failure(_lease, uncertain, terminal) {
      Object.assign(state, {
        status: uncertain ? "outcome_unknown" : terminal ? "failed_terminal" : "failed_retryable",
      });
    },
    async recover(expected, fingerprint) {
      await effect("recover");
      if (state.status !== "outcome_unknown" || state.fencingEpoch !== expected.fencingEpoch) throw new Error("CAS conflict");
      Object.assign(state, { status: "succeeded", responseStatus: 200, receipt: { reconciliation: {
        source: "project.release.authority", observed_at: stamp,
        evidence_code: "RELEASE_AUTHORITY_CONFIRMED", evidence_fingerprint: fingerprint,
        target_status: "succeeded",
      } } });
    },
    async read() { return structuredClone(state); },
  };
  const ports: ApplicationActivationPorts = {
    mutations,
    readActive: async () => structuredClone(active),
    writeActive: async value => { await effect("authority"); active = structuredClone(value); },
    confirmActive: async () => { await effect("confirm"); },
    checkCompatibility: async () => { await effect("compatibility"); },
    prepare: async () => { await effect("prepare"); },
    start: async () => { await effect("start"); },
    stop: async () => { await effect("stop"); },
    requireStopped: async () => { await effect("stopped"); },
    requireReady: async () => { await effect("ready"); },
    route: async () => { await effect("route"); },
    verifyRoute: async () => { await effect("route-readback"); },
  };
  const activation = new ApplicationActivationService(ports);
  const activationInput = {
    runtime, environment: { api: { APP_SETTING: "private-config-sentinel" }, jobs: {} },
    configurationId, hosts: { api: ["reviews.example.test"] }, expectedActivationId: null, principal: state.principal,
  };
  const archives: DeliveryMigrationArchive[] = runtime.release.targets.map(target => ({
    target: target.name, objectId: target.object_id, artifactVerified: true,
    migrations: migrationSql ? [{ ...migration, sha256: new Bun.CryptoHasher("sha256").update(migration.sql).digest("hex") }] : [],
  }));
  let backup: LogicalBackupIdentity | null = null;
  const migrations = new ApplicationMigrations({
    storage: { readMigrations: async () => ({ record: runtime.release, archives }) },
    inventory: async () => structuredClone(ledger),
    withLock: async (_input, action) => action(),
    now: () => now,
    backups: {
      create: async (_ref, id) => {
        await effect("backup-create");
        expect(state.checkpoint["backup_id"]).toBe(id!);
        expect(state.checkpoint["phase"]).toBe("migrating");
        backup = {
          backup_id: id!, project_ref: "demo", database: "supa_demo", kind: "logical-full",
          created_at: stamp, completed_at: stamp, bytes: 128, sha256: "e".repeat(64),
        };
        return backup;
      },
      read: async () => { await effect("backup-read"); return structuredClone(backup!); },
    },
    execute: async input => {
      await effect("sql");
      const row = {
        version: input.version, name: input.name, checksum: calculateMigrationChecksum(input),
        statements: [...input.statements], statement_count: input.statements.length, applied_at: null,
      };
      ledger.push(row);
      return { checksum: row.checksum, alreadyApplied: false, strippedTransactionWrappers: 0 };
    },
  });
  const observedPlan = () => {
    if (!active || !persisted) return structuredClone(plan);
    const observed = structuredClone(content);
    observed.target = {
      ...observed.target, artifact_action: "reuse", current_release_id: runtime.release.release_id,
      activation_id: active.runtime.activationId,
      receipt_confirmed: hasApplicationPromotionActivationReceipt(state, active, state.status === "running"),
      ready: true, smoke_verified: true, evidence_sha256: stableSha256(persisted), migration_ledger_digest: ledgerDigest(),
    };
    observed.migrations = { ...observed.migrations, ledger_digest: ledgerDigest(),
      project_migrations_applied: true, pending_versions: [] };
    observed.backup = { required: false, confirmed: false };
    observed.blockers = [];
    return makePlan(observed);
  };
  const smoke = (record: ApplicationActiveRecord): DeploymentEvidence => {
    const evidence: Omit<DeploymentEvidence, "status"> = {
      schema: "supacloud.deployment-evidence.v1", recorded_at: stamp,
      scope: { project_ref: "demo", application_id: "reviews", environment_id: "test" },
      source: { commit_sha: null, manifest_sha256: runtime.release.manifest_sha256, contract_schema: null, environment_binding_version: null },
      database: {
        provider: "postgresql", version: "18", topology: "single-node",
        migration: { status: "confirmed", inventory_sha256: ledgerDigest(), compatibility: "verified" },
        backup: { status: "unknown", latest_success_at: null, freshness_seconds: null },
        recovery: { status: "unknown", drill_id: null, rpo_seconds: null, rto_seconds: null },
      },
      components: [{ name: "worker", version: null, status: "confirmed", health_check: null, checked_at: stamp }],
      activation: { release_id: runtime.release.release_id, configuration_id: configurationId, activation_id: record.runtime.activationId },
      health: { status: "confirmed", checked_at: stamp, authenticated_smoke: "confirmed" },
      rollback: { release_id: null, configuration_id: null, status: "unknown", result: null }, notes: [],
    };
    return { ...evidence, status: deriveDeploymentEvidenceStatus(evidence) };
  };
  const dependencies: ApplicationPromotionExecutorDependencies = {
    mutations, migrations, now: () => now,
    promotions: { readPlan: async () => observedPlan(), readOwnedPlan: async () => observedPlan() },
    transfers: { transfer: async () => {
      await effect("transfer");
      expect(state.checkpoint["phase"]).toBe("transferring");
      return {
        schema: "supacloud.application-release-transfer-result.v1", project_ref: "demo", application_id: "reviews",
        source: { project_ref: "staging", release_id: sourceReleaseId, manifest_sha256: runtime.release.manifest_sha256 },
        candidate_release_id: runtime.release.release_id, release: runtime.release, activation_performed: false,
      };
    } },
    releases: { readRelease: async () => structuredClone(runtime.release) },
    active: { readForApplication: async () => structuredClone(active) },
    evidence: {
      read: async () => structuredClone(persisted),
      write: async evidence => { await effect("evidence"); persisted = structuredClone(evidence); return persisted; },
    },
    deployment: {
      activatePromotionConfigured: async input => activation.activatePromotion({
        ...activationInput, runtime: { ...runtime, activationId: input.runtime.activationId },
      }, input.owner, database),
      observePromotion: (parent, record) => activation.observePromotion(parent, record),
    },
    verifySmoke: async record => { await effect("smoke"); return smoke(record); },
  };
  const executeInput = {
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    sourceProjectRef: "staging", sourceEnvironmentId: "staging", sourceReleaseId,
    mutationId: parentId, plan, principal: state.principal,
  };
  const reconcileInput = {
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    mutationId: parentId, principal: state.principal,
  };
  const planner = (overrides: Partial<ApplicationPromotionDependencies> = {}) => {
    const source: ApplicationActiveRecord = {
      schema: "supacloud.application-active.v1", configurationDigest: "d".repeat(64), configurationId,
      hosts: { api: ["reviews.example.test"] },
      runtime: {
        ...runtime, environmentId: "staging", activationId: content.source.activation_id!,
        release: { ...runtime.release, project_ref: "staging", release_id: sourceReleaseId },
      },
    };
    const sourceState: ProjectMutationState = {
      ...state, projectRef: "staging", mutationId: source.runtime.activationId, operation: "application.release.activate",
      resourceKey: projectMutationResourceKey({
        type: "application_release",
        id: stableSha256({ applicationId: "reviews", environmentId: "staging" }),
      }),
      status: "succeeded", responseStatus: 200, checkpoint: {}, receipt: {
        project_ref: "staging", application_id: "reviews", environment_id: "staging", release_id: sourceReleaseId,
        activation_id: source.runtime.activationId, replayed: false,
      },
    };
    const sourceEvidence = smoke(source);
    sourceEvidence.scope = { project_ref: "staging", application_id: "reviews", environment_id: "staging" };
    sourceEvidence.activation.release_id = sourceReleaseId;
    const sourceCheckpoint = {
      schema: "supacloud.application-activation.v1", phase: "committed",
      desired: {
        ...source,
        hosts: Object.entries(source.hosts ?? {}).map(([target, hosts]) => ({ target, hosts })),
        runtime: {
          ...source.runtime,
          ports: Object.entries(source.runtime.ports).map(([target, port]) => ({ target, port })),
        },
      },
      previous: null,
    };
    return new ApplicationPromotions({
      storage: { readMigrations: async () => ({ record: structuredClone(source.runtime.release), archives }) },
      transfers: { readPlan: async () => ({
        schema: "supacloud.application-release-transfer-plan.v1", project_ref: "demo", application_id: "reviews",
        source: { project_ref: "staging", release_id: sourceReleaseId, manifest_sha256: runtime.release.manifest_sha256 },
        candidate_release_id: runtime.release.release_id, action: active ? "no-op" : "materialize", execution_performed: false,
      }) },
      active: { readForApplication: async ref => structuredClone(ref === "staging" ? source : active) },
      configurations: { read: async () => structuredClone(content.target.configuration) },
      migrations,
      readiness: { inspect: async value => ({
        project_ref: value.release.project_ref, application_id: "reviews", environment_id: value.environmentId,
        release_id: value.release.release_id, activation_id: value.activationId, ready: true,
        targets: applicationRuntimePlan(value).targets.map(target => ({
          target: target.name, kind: target.kind, unit: target.unit,
          pid: 100, invocation_id: "f".repeat(32), ready: true, code: "READY" as const,
        })),
      }) },
      evidence: { read: async ref => structuredClone(ref === "staging" ? sourceEvidence : persisted) },
      mutations: { read: async (ref, id) => structuredClone(
        ref === "staging" && id === source.runtime.activationId
          ? { ...sourceState, checkpoint: sourceCheckpoint,
            requestFingerprint: stableSha256({ desired: source, expectedActivationId: null }) }
          : id === parentId ? state : null,
      ) },
      assertIdle: async scope => {
        if (scope.projectRef === "demo" && ["running", "outcome_unknown"].includes(state.status)) {
          throw new ApplicationPromotionError("APPLICATION_PROMOTION_BUSY", 409);
        }
      },
      assertReconciling: (scope, expected) => database.begin(transaction =>
        assertApplicationPromotionReconciliation(scope, expected, transaction)),
      now: () => now, ...overrides,
    });
  };
  return {
    runtime, state, initial, owner, database, activation, activationInput, calls, phases, ports,
    dependencies, executeInput, reconcileInput, planner, observedPlan, makePlan, content, smoke, ledger, request,
    executor: () => new ApplicationPromotionExecutor(dependencies),
    reconciler: (promotions = planner()) => new ApplicationPromotionReconciler({
      promotions, mutations, active: dependencies.active, deployment: dependencies.deployment,
    }),
    prepareParent: () => { state.checkpoint = structuredClone(initial); },
    active: () => active,
    evidence: () => persisted,
    expire: () => { expired = true; },
    failAt: (name: string) => { failAt = name; },
  };
}

test("delegation records all activation phases under a distinct parent without completing it", async () => {
  const f = fixture();
  f.prepareParent();
  const before = structuredClone(f.state.checkpoint);
  const result = await f.activation.activatePromotion(f.activationInput, f.owner, f.database);
  expect(result.activation_id).not.toBe(parentId);
  expect(f.state.status).toBe("running");
  expect(f.state.checkpoint["phase"]).toBe("verifying");
  expect(f.state.checkpoint["plan"]).toEqual(before["plan"]);
  expect(f.state.checkpoint["backup_id"]).toEqual(before["backup_id"]);
  expect(f.state.checkpoint["migration"]).toEqual(before["migration"]);
  expect(f.phases.filter((phase, index, all) => index === 0 || phase !== all[index - 1]))
    .toEqual(["prepared", "transitioning", "started", "healthy", "routed", "committed"]);
  expect(f.calls).not.toContain("begin");
  expect(f.calls).not.toContain("success");
  expect(JSON.stringify(f.state)).not.toContain("private-config-sentinel");
  expect(f.active()?.promotionMutationId).toBe(parentId);
  expect(hasApplicationPromotionActivationReceipt(f.state, f.active()!, true)).toBe(true);
  expect(hasApplicationPromotionActivationReceipt(f.state, f.active()!)).toBe(false);
});

test("a completed delegation is only observed by a reconstructed controller", async () => {
  const f = fixture();
  f.prepareParent();
  await f.activation.activatePromotion(f.activationInput, f.owner, f.database);
  f.calls.length = 0;
  const reconstructed = new ApplicationActivationService(f.ports);
  expect((await reconstructed.activatePromotion(f.activationInput, f.owner, f.database)).replayed).toBe(true);
  expect(f.calls).toEqual(["ready", "route-readback"]);
});

test.each(["prepare", "start", "ready", "route", "authority"])(
  "an interrupted %s delegation is never replayed",
  async phase => {
    const f = fixture();
    f.prepareParent();
    f.failAt(phase);
    await expect(f.activation.activatePromotion(f.activationInput, f.owner, f.database)).rejects.toThrow();
    f.calls.length = 0;
    await expect(new ApplicationActivationService(f.ports)
      .activatePromotion(f.activationInput, f.owner, f.database)).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(f.calls).toEqual([]);
    expect(f.state.status).toBe("running");
  },
);

test.each(["epoch", "expired", "request", "parent-id", "plan", "child-id", "principal", "resource"])(
  "delegation rejects changed %s binding before runtime effects",
  async fault => {
    const f = fixture();
    f.prepareParent();
    if (fault === "epoch") f.owner.lease.fencingEpoch++;
    if (fault === "expired") f.expire();
    if (fault === "request") f.owner.requestFingerprint = "b".repeat(64);
    if (fault === "parent-id") f.owner.lease.mutationId = f.runtime.activationId;
    if (fault === "plan") {
      const changed = structuredClone(f.content);
      changed.source.evidence_sha256 = "a".repeat(64);
      f.state.checkpoint["plan"] = f.makePlan(changed);
    }
    if (fault === "child-id") f.state.checkpoint["activation_id"] = parentId;
    if (fault === "principal") f.owner.principal = { type: "admin", id: "other-admin" };
    if (fault === "resource") f.state.resourceKey = projectMutationResourceKey(applicationPromotionResource("reviews", "foreign"));
    await expect(f.activation.activatePromotion(f.activationInput, f.owner, f.database)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);

test("executor persists identities before effects and completes only after smoke and evidence readback", async () => {
  const f = fixture();
  const result = await f.executor().execute(f.executeInput);
  expect(result.action).toBe("promote");
  expect(result.replayed).toBe(false);
  expect(result.activation_id).not.toBe(parentId);
  expect(f.calls.indexOf("checkpoint:prepared")).toBeLessThan(f.calls.indexOf("transfer"));
  expect(f.calls.indexOf("smoke")).toBeLessThan(f.calls.indexOf("evidence"));
  expect(f.calls.indexOf("evidence")).toBeLessThan(f.calls.indexOf("success"));
  expect(f.state.status).toBe("succeeded");
  expect(f.state.receipt?.["backup_id"]).toMatch(/^logical-full_demo_[a-f0-9]{32}$/);
  expect(parseApplicationPromotionCheckpoint(f.state).activation_id).toBe(result.activation_id!);
  expect(hasApplicationPromotionActivationReceipt(f.state, f.active()!)).toBe(true);
  expect(JSON.stringify(f.state)).not.toContain("private-config-sentinel");
  f.calls.length = 0;
  expect((await f.executor().execute(f.executeInput)).replayed).toBe(true);
  expect(f.calls).toEqual(["begin"]);
});

test.each(["transfer", "start", "smoke", "evidence", "success"])(
  "executor preserves uncertain %s outcome without replay or data restore",
  async phase => {
    const f = fixture();
    f.failAt(phase);
    await expect(f.executor().execute(f.executeInput)).rejects.toThrow();
    const checkpoint = structuredClone(f.state.checkpoint);
    expect(f.state.status).toBe("outcome_unknown");
    f.calls.length = 0;
    await expect(f.executor().execute(f.executeInput)).rejects.toThrow("OUTCOME_UNRESOLVED");
    expect(f.calls).toEqual(["begin"]);
    expect(f.state.checkpoint).toEqual(checkpoint);
  },
);

test("changed reviewed plan is rejected before effects", async () => {
  const f = fixture();
  const changed = structuredClone(f.content);
  changed.source.evidence_sha256 = "a".repeat(64);
  f.dependencies.promotions.readOwnedPlan = async () => f.makePlan(changed);
  await expect(f.executor().execute(f.executeInput)).rejects.toThrow("PLAN_CHANGED");
  expect(f.state.status).toBe("failed_terminal");
  expect(f.calls).toEqual(["begin", "checkpoint:prepared"]);
});

test("no-op is freshly observed and creates no parent mutation", async () => {
  const f = fixture();
  await f.executor().execute(f.executeInput);
  const noOp = f.observedPlan();
  f.calls.length = 0;
  expect((await f.executor().execute({ ...f.executeInput, plan: noOp })).action).toBe("no-op");
  expect(f.calls).toEqual([]);
  f.dependencies.promotions.readPlan = async () => structuredClone(f.executeInput.plan);
  await expect(f.executor().execute({ ...f.executeInput, plan: noOp })).rejects.toThrow("PLAN_CHANGED");
  expect(f.calls).toEqual([]);
});

test.each(["stale", "scope", "activation", "unknown-smoke", "ledger"])(
  "%s smoke cannot complete a promotion", async fault => {
    const f = fixture();
    const original = f.dependencies.verifySmoke;
    f.dependencies.verifySmoke = async record => {
      const evidence = await original(record);
      if (fault === "stale") evidence.health.checked_at = new Date(now - 1).toISOString();
      if (fault === "scope") evidence.scope.project_ref = "other";
      if (fault === "activation") evidence.activation.activation_id = parentId;
      if (fault === "unknown-smoke") evidence.health.authenticated_smoke = "unknown";
      if (fault === "ledger") evidence.database.migration.inventory_sha256 = "a".repeat(64);
      evidence.status = deriveDeploymentEvidenceStatus(evidence);
      return evidence;
    };
    await expect(f.executor().execute(f.executeInput)).rejects.toThrow();
    expect(f.state.status).toBe("outcome_unknown");
    expect(f.calls).not.toContain("success");
  },
);

test("resumed executor cannot overwrite an existing uncertain checkpoint", async () => {
  const f = fixture();
  f.prepareParent();
  const before = structuredClone(f.state.checkpoint);
  await expect(f.executor().execute(f.executeInput)).rejects.toThrow("RECONCILIATION_REQUIRED");
  expect(f.state.checkpoint).toEqual(before);
  expect(f.calls).toEqual(["begin"]);
});

test("pending SQL uses a durable backup identity and exact readback before activation", async () => {
  const f = fixture("CREATE TABLE public.promotion_fixture(id integer);");
  await f.executor().execute(f.executeInput);
  expect(f.calls.indexOf("checkpoint:migrating")).toBeLessThan(f.calls.indexOf("backup-create"));
  expect(f.calls.indexOf("backup-read")).toBeLessThan(f.calls.indexOf("sql"));
  expect(f.calls.indexOf("sql")).toBeLessThan(f.calls.indexOf("start"));
  expect(f.ledger).toHaveLength(1);
  const parent = parseApplicationPromotionCheckpoint(f.state);
  expect(parent["migration"]).toMatchObject({
    backup: { backup_id: parent.backup_id, sha256: "e".repeat(64) },
    before_ledger_digest: f.executeInput.plan.migrations.ledger_digest,
  });
});

test.each(["backup-create", "backup-read", "sql"])("uncertain %s blocks promotion and cannot be retried", async stage => {
  const f = fixture("CREATE TABLE public.promotion_fixture(id integer);");
  f.failAt(stage);
  await expect(f.executor().execute(f.executeInput)).rejects.toThrow();
  expect(f.state.status).toBe("outcome_unknown");
  expect(f.calls).not.toContain("start");
  const backup = f.state.checkpoint["backup_id"];
  f.calls.length = 0;
  await expect(f.executor().execute(f.executeInput)).rejects.toThrow("OUTCOME_UNRESOLVED");
  expect(f.state.checkpoint["backup_id"]).toBe(backup);
  expect(f.calls).toEqual(["begin"]);
});

test("unapproved destructive SQL cannot reach backup or runtime effects", async () => {
  const f = fixture("DELETE FROM public.promotion_fixture;");
  await expect(f.executor().execute(f.executeInput)).rejects.toThrow("APPLICATION_MIGRATION_REVIEW_REQUIRED");
  expect(f.calls).not.toContain("backup-create");
  expect(f.calls).not.toContain("sql");
  expect(f.calls).not.toContain("start");
});

test.each([
  ["no SQL", "success"], ["pending SQL", "success"],
  ["no SQL", "checkpoint:verifying"], ["pending SQL", "checkpoint:verifying"],
] as const)(
  "lost %s final %s is reconciled using the real planner without repeating effects", async (migration, stage) => {
    const f = fixture(migration === "pending SQL" ? "CREATE TABLE public.promotion_fixture(id integer);" : undefined);
    f.failAt(stage);
    await expect(f.executor().execute(f.executeInput)).rejects.toThrow("OUTCOME_UNRESOLVED");
    const planner = f.planner();
    const promotion = { ...f.executeInput, configurationId };
    await expect(planner.readPlan(promotion)).rejects.toThrow("APPLICATION_PROMOTION_BUSY");
    expect((await planner.readReconciliationPlan(promotion, f.state)).action).toBe("no-op");
    expect(hasApplicationPromotionActivationReceipt(f.state, f.active()!, true)).toBe(false);
    const journal = structuredClone(f.state.checkpoint);
    f.calls.length = 0;
    const result = await f.reconciler(planner).reconcile(f.reconcileInput, async source => {
      expect(source.sourceProjectRef).toBe("staging");
      expect(source.configurationId).toBe(configurationId);
    });
    expect(result.mutation["status"]).toBe("succeeded");
    expect(result.promotion.phase).toBe("verifying");
    expect(f.state.checkpoint).toEqual(journal);
    expect(f.calls).toEqual(["ready", "route-readback", "ready", "route-readback", "recover"]);
    expect(hasApplicationPromotionActivationReceipt(f.state, f.active()!)).toBe(true);
    f.calls.length = 0;
    f.dependencies.promotions = planner;
    expect((await f.executor().execute(f.executeInput)).replayed).toBe(true);
    expect(f.calls).toEqual(["begin"]);
  },
);

test.each(["timestamp", "fingerprint", "source", "extra-field"])(
  "replay rejects a malformed recovery %s receipt before any effect", async fault => {
    const f = fixture();
    f.failAt("success");
    await expect(f.executor().execute(f.executeInput)).rejects.toThrow();
    await f.reconciler().reconcile(f.reconcileInput, async () => {});
    const reconciliation = f.state.receipt!["reconciliation"] as Record<string, unknown>;
    if (fault === "timestamp") reconciliation["observed_at"] = "not-a-time";
    if (fault === "fingerprint") reconciliation["evidence_fingerprint"] = "e".repeat(64);
    if (fault === "source") reconciliation["source"] = "caller";
    if (fault === "extra-field") reconciliation["caller_evidence"] = true;
    expect(hasApplicationPromotionActivationReceipt(f.state, f.active()!)).toBe(false);
    f.calls.length = 0;
    await expect(f.executor().execute(f.executeInput)).rejects.toThrow("RECEIPT_INVALID");
    expect(f.calls).toEqual(["begin"]);
  },
);

test("promotion status exposes fixed metadata without arbitrary journal values or effects", async () => {
  const f = fixture();
  f.prepareParent();
  f.state.checkpoint["provider_note"] = "private-journal-sentinel";
  const result = await f.reconciler().status(f.reconcileInput);
  expect(result.mutation["checkpoint"]).toEqual({});
  expect(result.promotion).toMatchObject({
    phase: "activating", activation_id: f.runtime.activationId,
    plan_sha256: f.executeInput.plan.plan_sha256, configuration_id: configurationId,
  });
  expect(JSON.stringify(result)).not.toContain("private-journal-sentinel");
  expect(JSON.stringify(result)).not.toContain(f.owner.lease.leaseToken);
  expect(JSON.stringify(result)).not.toContain("private-config-sentinel");
  expect(f.calls).toEqual([]);
});

test.each(["principal", "project", "application", "environment", "mutation", "resource"])(
  "status and reconciliation reject a foreign %s before observations", async fault => {
    const f = fixture();
    f.prepareParent();
    f.state.status = "outcome_unknown";
    const identity = structuredClone(f.reconcileInput);
    if (fault === "principal") identity.principal.id = "other";
    if (fault === "project") identity.projectRef = "foreign";
    if (fault === "application") identity.applicationId = "foreign";
    if (fault === "environment") identity.environmentId = "foreign";
    if (fault === "mutation") identity.mutationId = configurationId;
    if (fault === "resource") f.state.resourceKey = null;
    await expect(f.reconciler().status(identity)).rejects.toThrow("NOT_FOUND");
    await expect(f.reconciler().reconcile(identity, async () => { throw new Error("Source must not be read"); }))
      .rejects.toThrow("NOT_FOUND");
    expect(f.calls).toEqual([]);
  },
);

test.each(["pending", "running", "failed_retryable", "failed_terminal", "succeeded"] as const)(
  "%s promotion reconciliation reads status only", async status => {
    const f = fixture();
    f.prepareParent();
    f.state.status = status;
    expect((await f.reconciler().reconcile(f.reconcileInput, async () => {
      throw new Error("Source must not be read");
    })).mutation["status"]).toBe(status);
    expect(f.calls).toEqual([]);
  },
);

test.each(["transfer", "backup-create", "sql", "start", "smoke", "evidence"])(
  "uncertain %s cannot be reconciled by replaying effects", async stage => {
    const f = fixture(stage === "backup-create" || stage === "sql" ? "SELECT 1;" : undefined);
    f.failAt(stage);
    await expect(f.executor().execute(f.executeInput)).rejects.toThrow();
    const journal = structuredClone(f.state.checkpoint);
    f.calls.length = 0;
    await expect(f.reconciler().reconcile(f.reconcileInput, async () => {})).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(f.state.status).toBe("outcome_unknown");
    expect(f.state.checkpoint).toEqual(journal);
    expect(f.calls.every(call => ["ready", "route-readback"].includes(call))).toBe(true);
  },
);

test.each(["stale-smoke", "ledger", "authority", "journal", "gateway", "source-busy", "epoch", "cas", "receipt"])(
  "changed %s leaves promotion recovery unresolved", async fault => {
    const f = fixture();
    f.failAt("success");
    await expect(f.executor().execute(f.executeInput)).rejects.toThrow();
    if (fault === "stale-smoke") f.evidence()!.health.checked_at = new Date(now - 31 * 60_000).toISOString();
    if (fault === "ledger") f.ledger.push({
      version: "2", name: "foreign", checksum: "e".repeat(64), statements: ["SELECT 2;"],
      statement_count: 1, applied_at: null,
    });
    if (fault === "authority") f.active()!.configurationDigest = "e".repeat(64);
    if (fault === "journal") f.state.checkpoint["activation"] = {};
    if (fault === "gateway") f.failAt("route-readback");
    if (fault === "cas") f.failAt("recover");
    if (fault === "receipt") {
      f.dependencies.mutations!.recover = async () => { f.state.status = "succeeded"; f.state.receipt = {}; };
    }
    let observations = 0;
    const planner = f.planner({
      ...(fault === "source-busy" ? { assertIdle: async () => {
        throw new ApplicationPromotionError("APPLICATION_PROMOTION_BUSY", 409);
      } } : {}),
      ...(fault === "epoch" ? { assertReconciling: async (scope, state) => {
        if (++observations === 2) f.state.fencingEpoch++;
        await f.database.begin(transaction => assertApplicationPromotionReconciliation(scope, state, transaction));
      } } : {}),
    });
    f.calls.length = 0;
    await expect(f.reconciler(planner).reconcile(f.reconcileInput, async () => {})).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(f.calls.every(call => ["ready", "route-readback", "recover"].includes(call))).toBe(true);
    if (fault !== "receipt") expect(f.state.status).toBe("outcome_unknown");
    if (!["cas", "receipt"].includes(fault)) expect(f.calls).not.toContain("recover");
  },
);

test("promotion observation routes preserve target, principal and persisted source authorization", async () => {
  const f = fixture();
  f.failAt("success");
  await expect(f.executor().execute(f.executeInput)).rejects.toThrow();
  f.calls.length = 0;
  const seen: string[] = [];
  let blocked: string | undefined;
  let authenticated = true;
  const routes = createApplicationRoutes({
    projectExists: async () => true,
    authorize: async request => {
      const path = new URL(request.url).pathname;
      seen.push(`${request.method}:${path}`);
      return path.endsWith(blocked ?? "\0") ? { status: 403, body: { error: "Denied" } } : undefined;
    },
    principal: async () => authenticated ? f.executeInput.principal : null,
    promotionReconciler: f.reconciler(),
  });
  const path = `http://localhost/v1/projects/demo/applications/reviews/environments/test/promotions/${parentId}`;
  expect((await routes.handle(new Request(path))).status).toBe(200);
  expect(seen).toHaveLength(1);
  expect(f.calls).toEqual([]);
  const post = () => new Request(`${path}/reconcile`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  authenticated = false;
  expect((await routes.handle(post())).status).toBe(401);
  authenticated = true;
  blocked = "runtime";
  expect((await routes.handle(post())).status).toBe(403);
  expect(seen.slice(-3)).toEqual([
    `POST:/v1/projects/demo/applications/reviews/environments/test/promotions/${parentId}/reconcile`,
    `GET:/v1/projects/staging/applications/reviews/releases/${f.executeInput.sourceReleaseId}`,
    "GET:/v1/projects/staging/applications/reviews/environments/staging/runtime",
  ]);
  expect(f.calls).toEqual([]);
  blocked = undefined;
  const result = await routes.handle(post());
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ mutation: { status: "succeeded" } });
});

test("uncomposed promotion observation routes remain inert", async () => {
  const f = fixture();
  const routes = createApplicationRoutes({
    projectExists: async () => true, authorize: async () => undefined,
    principal: async () => f.executeInput.principal,
  });
  const path = `http://localhost/v1/projects/demo/applications/reviews/environments/test/promotions/${parentId}`;
  for (const request of [new Request(path), new Request(`${path}/reconcile`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })]) {
    const result = await routes.handle(request);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ code: "APPLICATION_PROMOTION_RECONCILER_UNAVAILABLE" });
  }
  expect(f.calls).toEqual([]);
});

test("the execution route separately authorizes source artifact and source runtime before dispatch", async () => {
  const f = fixture();
  const seen: string[] = [];
  let blocked: string | undefined;
  const routes = createApplicationRoutes({
    projectExists: async () => true,
    authorize: async (request, ref) => {
      const path = new URL(request.url).pathname;
      seen.push(`${request.method}:${ref}:${path}`);
      return path.endsWith(blocked ?? "\0") ? { status: 403, body: { error: "Denied" } } : undefined;
    },
    principal: async () => f.executeInput.principal,
    promotionExecutor: f.executor(),
  });
  const body = {
    mutation_id: parentId, source_ref: "staging", source_environment_id: "staging",
    source_release_id: f.executeInput.sourceReleaseId, configuration_id: configurationId, plan: f.executeInput.plan,
  };
  const post = () => new Request("http://localhost/v1/projects/demo/applications/reviews/environments/test/promotions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  blocked = "runtime";
  expect((await routes.handle(post())).status).toBe(403);
  expect(f.calls).toEqual([]);
  expect(seen).toEqual([
    "POST:demo:/v1/projects/demo/applications/reviews/environments/test/promotions",
    `GET:staging:/v1/projects/staging/applications/reviews/releases/${body.source_release_id}`,
    "GET:staging:/v1/projects/staging/applications/reviews/environments/staging/runtime",
  ]);
  blocked = undefined;
  expect((await routes.handle(post())).status).toBe(200);
  expect(f.state.status).toBe("succeeded");
});

test("uncomposed execution route stays inert and cannot expose secrets", async () => {
  const f = fixture();
  const routes = createApplicationRoutes({
    projectExists: async () => true, authorize: async () => undefined,
    principal: async () => f.executeInput.principal,
  });
  const response = await routes.handle(new Request(
    "http://localhost/v1/projects/demo/applications/reviews/environments/test/promotions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        mutation_id: parentId, source_ref: "staging", source_environment_id: "staging",
        source_release_id: f.executeInput.sourceReleaseId, configuration_id: configurationId, plan: f.executeInput.plan,
      }),
    },
  ));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "APPLICATION_PROMOTION_EXECUTOR_UNAVAILABLE" });
  expect(f.calls).toEqual([]);
});

test.each(["valid", "nonce", "digest", "unauthenticated", "provider-error", "configuration"])(
  "trusted smoke %s binds nonce, immutable configuration and authority without reflecting credentials",
  async fault => {
    const f = fixture();
    f.prepareParent();
    await f.activation.activatePromotion(f.activationInput, f.owner, f.database);
    let runs = 0;
    const verifier = createApplicationSmokeVerifier({
      resolve: async () => ({
        bunVersion: "1.4.2", environment: fault === "configuration" ? { api: {}, jobs: {} } : f.activationInput.environment,
        hosts: f.activationInput.hosts,
      }),
    }, {
      executable: async () => "/trusted-fixture-smoke",
      execute: async (_path, raw) => {
        runs++;
        const envelope = JSON.parse(raw) as { nonce: string; input_sha256: string };
        if (fault === "provider-error") throw new Error("private-config-sentinel");
        return JSON.stringify({
          schema: "supacloud.application-smoke-result.v1",
          nonce: fault === "nonce" ? parentId : envelope.nonce,
          input_sha256: fault === "digest" ? "a".repeat(64) : envelope.input_sha256,
          authenticated: fault !== "unauthenticated", evidence: f.smoke(f.active()!),
        });
      },
    });
    if (fault === "valid") {
      expect((await verifier(f.active()!)).health.authenticated_smoke).toBe("confirmed");
    } else {
      await expect(verifier(f.active()!)).rejects.toThrow(/^APPLICATION_PROMOTION_SMOKE_UNVERIFIED$/);
    }
    expect(runs).toBe(fault === "configuration" ? 0 : 1);
  },
);
