import { expect, test } from "bun:test";
import {
  applicationReleaseId, applicationPromotionPlanDigest, parseApplicationPromotionPlan,
  deriveDeploymentEvidenceStatus,
  type ApplicationReleaseRecord, type ApplicationConfigurationView, type DeploymentEvidence,
  type DeliveryMigrationArchive,
} from "@supacloud/delivery";
import {
  ApplicationPromotions, ApplicationPromotionError, type ApplicationPromotionDependencies,
} from "../../src/services/application-promotion";
import {
  ApplicationPromotionOwnershipError, type ApplicationPromotionOwner,
} from "../../src/services/application-promotion-ownership";
import type { ApplicationActiveRecord } from "../../src/services/application-activation";
import { ApplicationMigrations } from "../../src/services/application-migrations";
import { projectMutationResourceKey, type ProjectMutationState } from "../../src/services/project-mutation.service";
import { stableSha256 } from "../../src/utils/stable-json";
import { createApplicationRoutes } from "../../src/routes/applications";
import { calculateMigrationChecksum } from "../../src/services/migration-promotion";

const now = Date.parse("2026-10-11T04:00:00.000Z");
const activation = "01234567-89ab-4def-8123-456789abcdef";
const configurationId = "11234567-89ab-4def-8123-456789abcdef";
function release(projectRef: string): ApplicationReleaseRecord {
  return {
    schema: "supacloud.application-release.v1", project_ref: projectRef, application_id: "reviews",
    release_id: applicationReleaseId(projectRef, "reviews", "a".repeat(64)),
    manifest_sha256: "a".repeat(64), created_at: "2026-10-10T00:00:00.000Z",
    targets: [{ name: "api", kind: "http", object_id: "b".repeat(64), entrypoint: "bundle/index.js" }],
  };
}
function active(projectRef: string): ApplicationActiveRecord {
  return {
    schema: "supacloud.application-active.v1", configurationDigest: "c".repeat(64), configurationId,
    hosts: { api: ["reviews.example.com"] },
    runtime: { release: release(projectRef), environmentId: projectRef, activationId: activation,
      ports: { api: 31000 }, bunVersion: "1.4.2" },
  };
}
function evidence(projectRef: string): DeploymentEvidence {
  const stamp = new Date(now - 60_000).toISOString();
  const input: Omit<DeploymentEvidence, "status"> = {
    schema: "supacloud.deployment-evidence.v1", recorded_at: stamp,
    scope: { project_ref: projectRef, application_id: "reviews", environment_id: projectRef },
    source: { commit_sha: null, manifest_sha256: "a".repeat(64), contract_schema: null, environment_binding_version: null },
    database: {
      provider: "postgresql", version: "18", topology: "single-node",
      migration: { status: "confirmed", inventory_sha256: stableSha256([]), compatibility: "verified" },
      backup: { status: "unknown", latest_success_at: null, freshness_seconds: null },
      recovery: { status: "unknown", drill_id: null, rpo_seconds: null, rto_seconds: null },
    },
    components: [{ name: "management-api", version: null, status: "confirmed", health_check: "/health", checked_at: stamp }],
    activation: { release_id: release(projectRef).release_id, configuration_id: configurationId, activation_id: activation },
    health: { status: "confirmed", checked_at: stamp, authenticated_smoke: "confirmed" },
    rollback: { release_id: null, configuration_id: null, status: "unknown", result: null }, notes: [],
  };
  return { ...input, status: deriveDeploymentEvidenceStatus(input) };
}
function state(record: ApplicationActiveRecord): ProjectMutationState {
  const desired = structuredClone(record);
  const encoded = {
    ...desired,
    hosts: Object.entries(desired.hosts ?? {}).map(([target, hosts]) => ({ target, hosts })),
    runtime: {
      ...desired.runtime,
      ports: Object.entries(desired.runtime.ports).map(([target, port]) => ({ target, port })),
    },
  };
  return {
    projectRef: record.runtime.release.project_ref, mutationId: activation, operation: "application.release.activate",
    resourceKey: projectMutationResourceKey({
      type: "application_release",
      id: stableSha256({ applicationId: "reviews", environmentId: record.runtime.environmentId }),
    }),
    requestFingerprint: stableSha256({ desired, expectedActivationId: null }), principal: { type: "master", id: "fixture" },
    status: "succeeded", responseStatus: 200, receipt: {
      project_ref: record.runtime.release.project_ref, application_id: "reviews", environment_id: record.runtime.environmentId,
      release_id: record.runtime.release.release_id, activation_id: activation, replayed: false,
    },
    checkpoint: {
      schema: "supacloud.application-activation.v1", phase: "committed", desired: encoded, previous: null,
    },
    failureCode: null, leaseOwner: null, leaseExpiresAt: null, fencingEpoch: 1,
    completedAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  };
}
function fixture(
  assertIdle: NonNullable<ApplicationPromotionDependencies["assertIdle"]> = async () => {},
  overrides: Partial<Pick<ApplicationPromotionDependencies, "assertOwned">> = {},
) {
  const source = active("staging");
  let target: ApplicationActiveRecord | null = null;
  let configuration: ApplicationConfigurationView | null = {
    schema: "supacloud.application-configuration.v1", project_ref: "production", application_id: "reviews",
    environment_id: "production", configuration_id: configurationId, created_at: "2026-10-10T00:00:00.000Z",
    bun_version: "1.4.2", targets: [{ name: "api", kind: "http", hosts: ["reviews.example.com"], environment_names: ["DATABASE_URL"] }],
  };
  const sourceEvidence = evidence("staging");
  const targetEvidence = evidence("production");
  const sourceState = state(source), targetState = state(active("production"));
  const archives: DeliveryMigrationArchive[] = [];
  let artifactPresent = false, ready = true, reads = 0, fail = false, changeObservation = false, activeReads = 0;
  let changeLedger = false, inventoryReads = 0;
  const storage = { readMigrations: async () => ({ record: release("staging"), archives }) };
  const sourceInventory = () => archives.flatMap(archive => archive.migrations
    .filter(entry => entry.executor === "project-migration")
    .map(entry => ({
      version: entry.version, name: entry.name, statements: [entry.sql], statement_count: 1, applied_at: null,
      checksum: calculateMigrationChecksum({ version: entry.version, name: entry.name, statements: [entry.sql] }),
    })));
  const migrations = new ApplicationMigrations({ storage, inventory: async ref => {
    inventoryReads++;
    if (changeLedger && inventoryReads > 2 && ref === "staging") return [{
      version: "2", name: "changed", statements: ["SELECT 2;"], statement_count: 1, applied_at: null,
      checksum: "e".repeat(64),
    }];
    return ref === "staging" ? sourceInventory() : [];
  } });
  const service = new ApplicationPromotions({
    storage, migrations, assertIdle,
    transfers: { readPlan: async () => {
      reads++;
      return {
        schema: "supacloud.application-release-transfer-plan.v1", project_ref: "production", application_id: "reviews",
        source: { project_ref: "staging", release_id: release("staging").release_id, manifest_sha256: "a".repeat(64) },
        candidate_release_id: release("production").release_id,
        action: artifactPresent ? "no-op" : "materialize", execution_performed: false,
      };
    } },
    active: { readForApplication: async ref => {
      activeReads++;
      if (changeObservation && activeReads > 2 && ref === "staging") return null;
      return structuredClone(ref === "staging" ? source : target);
    } },
    configurations: { read: async () => structuredClone(configuration) },
    readiness: { inspect: async runtime => {
      if (fail) throw new Error("private-credential");
      return {
        project_ref: runtime.release.project_ref, application_id: "reviews", environment_id: runtime.environmentId,
        release_id: runtime.release.release_id, activation_id: runtime.activationId, ready,
        targets: [{ target: "api", kind: "http", pid: ready ? 100 : 0, invocation_id: ready ? "f".repeat(32) : null,
          unit: `supacloud-application-${runtime.release.project_ref}-${runtime.activationId}-api.service`,
          ready, code: ready ? "READY" : "PROCESS_NOT_RUNNING" }],
      };
    } },
    evidence: { read: async ref => structuredClone(ref === "staging" ? sourceEvidence : targetEvidence) },
    mutations: { read: async ref => structuredClone(ref === "staging" ? sourceState : targetState) },
    now: () => now,
    ...overrides,
  });
  const input = {
    projectRef: "production", applicationId: "reviews", environmentId: "production",
    sourceProjectRef: "staging", sourceEnvironmentId: "staging", sourceReleaseId: source.runtime.release.release_id,
  };
  return {
    service, input, source, sourceEvidence, sourceState, targetState, archives,
    setTarget: (value: ApplicationActiveRecord | null) => { target = value; },
    setConfiguration: (value: ApplicationConfigurationView | null) => { configuration = value; },
    setArtifact: () => { artifactPresent = true; },
    setReady: () => { ready = false; },
    fail: () => { fail = true; },
    drift: () => { changeObservation = true; },
    ledgerDrift: () => { changeLedger = true; },
    reads: () => reads,
    sourceLedgerDigest: () => stableSha256(sourceInventory().map(({ version, name, checksum }) => ({ version, name, checksum }))),
  };
}

test("promotion plan binds independent target configuration and never calls mutation adapters", async () => {
  const f = fixture();
  const plan = await f.service.readPlan(f.input);
  expect(plan.action).toBe("promote");
  expect(plan.steps).toEqual(["transfer", "activate-with-cas", "verify-runtime-and-smoke"]);
  expect(plan).toMatchObject({
    execution_performed: false, target: { artifact_action: "materialize", configuration: { project_ref: "production" } },
    source: { receipt_confirmed: true, ready: true, smoke_verified: true }, data_recovery: "separate-required",
  });
  expect(JSON.stringify(plan)).not.toContain("private-credential");
  expect(JSON.stringify(plan)).not.toContain("environment\":");
  expect(await f.service.readPlan(f.input)).toEqual(plan);
});

test("no-op requires active candidate, matching configuration, successful journal and fresh smoke", async () => {
  const f = fixture();
  f.setArtifact();
  expect((await f.service.readPlan(f.input)).action).toBe("promote");
  f.setTarget(active("production"));
  expect((await f.service.readPlan(f.input)).action).toBe("no-op");
  expect((await f.service.readPlan(f.input)).steps).toEqual([]);
  f.targetState.status = "outcome_unknown";
  expect((await f.service.readPlan(f.input)).action).toBe("promote");
});

test.each(["status", "scope", "operation", "resource", "bare-resource", "resource-type", "receipt"] as const)(
  "source journal %s mismatch blocks promotion", async fault => {
    const f = fixture();
    if (fault === "status") f.sourceState.status = "outcome_unknown";
    if (fault === "scope") f.sourceState.projectRef = "foreign";
    if (fault === "operation") f.sourceState.operation = "frontend.release.activate";
    if (fault === "resource") f.sourceState.resourceKey = "d".repeat(64);
    if (fault === "bare-resource") f.sourceState.resourceKey = stableSha256({
      applicationId: "reviews", environmentId: f.source.runtime.environmentId,
    });
    if (fault === "resource-type") f.sourceState.resourceKey = projectMutationResourceKey({
      type: "frontend_release",
      id: stableSha256({ applicationId: "reviews", environmentId: f.source.runtime.environmentId }),
    });
    if (fault === "receipt") f.sourceState.receipt!["release_id"] = "d".repeat(64);
    const plan = await f.service.readPlan(f.input);
    expect(plan.action).toBe("blocked");
    expect(plan.blockers).toContain("SOURCE_RECEIPT_UNCONFIRMED");
  },
);

test.each(["stale", "future", "activation", "configuration", "scope", "unknown-smoke"] as const)(
  "source %s evidence cannot authorize promotion", async fault => {
    const f = fixture();
    if (fault === "stale") f.sourceEvidence.health.checked_at = new Date(now - 31 * 60_000).toISOString();
    if (fault === "future") f.sourceEvidence.recorded_at = new Date(now + 1000).toISOString();
    if (fault === "activation") f.sourceEvidence.activation.activation_id = configurationId;
    if (fault === "configuration") f.sourceEvidence.activation.configuration_id = activation;
    if (fault === "scope") f.sourceEvidence.scope.environment_id = "other";
    if (fault === "unknown-smoke") f.sourceEvidence.health.authenticated_smoke = "unknown";
    f.sourceEvidence.status = deriveDeploymentEvidenceStatus(f.sourceEvidence);
    expect((await f.service.readPlan(f.input)).blockers).toContain("SOURCE_SMOKE_UNVERIFIED");
  },
);

test("pending migrations and operator provisioning produce explicit blocked prerequisites", async () => {
  const f = fixture();
  f.archives.push({
    target: "api", objectId: "b".repeat(64), artifactVerified: true,
    migrations: [{
      version: "1", name: "example", executor: "project-migration", path: "migrations/1_example.sql",
      sql: "SELECT 1;", sha256: stableSha256("SELECT 1;"), bytes: 9,
    }],
  });
  f.sourceEvidence.database.migration.inventory_sha256 = f.sourceLedgerDigest();
  const plan = await f.service.readPlan(f.input);
  expect(plan.action).toBe("blocked");
  expect(plan.blockers).toEqual(["MIGRATION_PENDING", "BACKUP_REQUIRED"]);
  expect(plan.steps).toEqual(["backup", "review-and-apply-migrations"]);
  expect(plan.backup).toEqual({ required: true, confirmed: false });
  expect(plan.migrations.pending_versions).toEqual(["1"]);
  f.archives[0]!.migrations[0]!.executor = "operator-provisioning";
  f.sourceEvidence.database.migration.inventory_sha256 = f.sourceLedgerDigest();
  expect((await f.service.readPlan(f.input)).blockers).toContain("OPERATOR_PROVISIONING_REQUIRED");
});

test("missing target configuration and non-ready source block the plan", async () => {
  const f = fixture();
  f.setConfiguration(null);
  f.setReady();
  const plan = await f.service.readPlan(f.input);
  expect(plan.blockers).toEqual(["SOURCE_NOT_READY", "TARGET_CONFIGURATION_MISSING"]);
  expect(plan.steps).toEqual(["verify-source", "bind-target-configuration"]);
});

test("activation changing during observations rejects the mixed plan", async () => {
  const f = fixture();
  f.drift();
  await expect(f.service.readPlan(f.input)).rejects.toMatchObject({
    code: "APPLICATION_PROMOTION_OBSERVATION_CHANGED", statusCode: 409,
  });
});

test("ledger changing during observations rejects the mixed plan", async () => {
  const f = fixture();
  f.ledgerDrift();
  await expect(f.service.readPlan(f.input)).rejects.toMatchObject({
    code: "APPLICATION_PROMOTION_OBSERVATION_CHANGED", statusCode: 409,
  });
});

test("missing explicit configuration preserves its immutable request ID", async () => {
  const f = fixture();
  f.setConfiguration(null);
  const plan = await f.service.readPlan({ ...f.input, configurationId });
  expect(plan.target.configuration_id).toBe(configurationId);
  expect(plan.blockers).toContain("TARGET_CONFIGURATION_MISSING");
});

test("candidate with a different active host binding does not become no-op", async () => {
  const f = fixture(), target = active("production");
  target.hosts = { api: ["other.example.com"] };
  f.setTarget(target);
  f.setArtifact();
  expect((await f.service.readPlan(f.input)).action).toBe("promote");
});

test("source smoke from a different live ledger cannot authorize promotion", async () => {
  const f = fixture();
  f.sourceEvidence.database.migration.inventory_sha256 = "e".repeat(64);
  expect((await f.service.readPlan(f.input)).blockers).toContain("SOURCE_SMOKE_UNVERIFIED");
});

test("tampered digest, scope, extra fields and contradictory no-op are rejected", async () => {
  const f = fixture(), plan = await f.service.readPlan(f.input);
  for (const change of [
    { plan_sha256: "d".repeat(64) }, { project_ref: "foreign" },
    { private: "secret" }, { action: "no-op" },
  ]) expect(() => parseApplicationPromotionPlan({ ...plan, ...change })).toThrow();
  const invalid = { ...plan, source: { ...plan.source, ready: false }, blockers: [], plan_sha256: "" };
  const { plan_sha256: _digest, ...content } = invalid;
  invalid.plan_sha256 = applicationPromotionPlanDigest(content);
  expect(() => parseApplicationPromotionPlan(invalid)).toThrow();
});

test("API requires separate source authorization before plan reads and redacts provider errors", async () => {
  const f = fixture(), access: string[] = [];
  const url = `http://localhost/v1/projects/production/applications/reviews/environments/production/promotion-plan`
    + `?source_ref=staging&source_environment_id=staging&source_release_id=${f.input.sourceReleaseId}`;
  const denied = createApplicationRoutes({
    projectExists: async () => true, promotions: f.service,
    authorize: async (_request, ref) => ref === "staging" ? { status: 403, body: { error: "Denied" } } : undefined,
  });
  expect((await denied.handle(new Request(url))).status).toBe(403);
  expect(f.reads()).toBe(0);
  const routes = createApplicationRoutes({
    projectExists: async () => true, promotions: f.service,
    authorize: async (request, ref) => { access.push(`${request.method} ${ref}`); return undefined; },
  });
  const response = await routes.handle(new Request(url));
  expect(response.status).toBe(200);
  expect(parseApplicationPromotionPlan(await response.json()).action).toBe("promote");
  expect(access).toEqual(["GET production", "GET staging", "GET staging"]);
  f.fail();
  const failure = await routes.handle(new Request(url));
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("private-credential");
});

test("promotion checks both exact environment scopes before observation and around readback", async () => {
  const checks: Array<{ projectRef: string; applicationId: string; environmentId: string }> = [];
  const f = fixture(async scope => { checks.push(scope); });
  expect((await f.service.readPlan(f.input)).action).toBe("promote");
  expect(checks).toEqual(Array.from({ length: 3 }, () => [
    { projectRef: "staging", applicationId: "reviews", environmentId: "staging" },
    { projectRef: "production", applicationId: "reviews", environmentId: "production" },
  ]).flat());
});

function promotionOwner(): ApplicationPromotionOwner {
  return {
    lease: {
      projectRef: "production", mutationId: activation,
      leaseToken: "21234567-89ab-4def-8123-456789abcdef", fencingEpoch: 3,
    },
    principal: { type: "admin", id: "admin:release" }, requestFingerprint: "d".repeat(64),
  };
}

test("owned plan revalidation bypasses only the exact target owner and still checks the source", async () => {
  const checks: string[] = [];
  const owned: string[] = [];
  const f = fixture(async scope => { checks.push(`idle:${scope.projectRef}:${scope.environmentId}`); }, {
    assertOwned: async (scope, candidate) => {
      owned.push(`${scope.projectRef}:${scope.environmentId}:${candidate.lease.mutationId}`);
    },
  });
  const owner = promotionOwner();
  const plan = await f.service.readOwnedPlan(f.input, owner);
  expect(plan.action).toBe("promote");
  expect(owned).toEqual(Array(3).fill("production:production:01234567-89ab-4def-8123-456789abcdef"));
  expect(checks).toEqual(Array(3).fill("idle:staging:staging"));
});

test("a target owner cannot bypass a busy source or enable public planning", async () => {
  let ownershipChecks = 0, sourceBusy = false;
  const f = fixture(async scope => {
    if (sourceBusy || scope.projectRef === "production") {
      throw new ApplicationPromotionError("APPLICATION_PROMOTION_BUSY", 409);
    }
  }, { assertOwned: async () => { ownershipChecks++; } });
  await expect(f.service.readPlan(f.input)).rejects.toMatchObject({ code: "APPLICATION_PROMOTION_BUSY" });
  expect(ownershipChecks).toBe(0);
  expect((await f.service.readOwnedPlan(f.input, promotionOwner())).action).toBe("promote");
  sourceBusy = true;
  const before = ownershipChecks;
  await expect(f.service.readOwnedPlan(f.input, promotionOwner())).rejects.toMatchObject({
    code: "APPLICATION_PROMOTION_BUSY", statusCode: 409,
  });
  expect(ownershipChecks).toBe(before);
});

test.each([1, 2, 3])("ownership lost at check %s rejects the plan without exposing the lease", async lostAt => {
  let checks = 0;
  const owner = promotionOwner();
  const f = fixture(async () => {}, {
    assertOwned: async () => {
      if (++checks === lostAt) throw new ApplicationPromotionOwnershipError();
    },
  });
  await expect(f.service.readOwnedPlan(f.input, owner)).rejects.toMatchObject({
    code: "APPLICATION_PROMOTION_OWNERSHIP_LOST", message: "APPLICATION_PROMOTION_OWNERSHIP_LOST", statusCode: 409,
  });
  expect(checks).toBe(lostAt);
  expect(f.reads()).toBe(lostAt === 1 ? 0 : 1);
});

test("owned planning snapshots the request and lease before asynchronous observations", async () => {
  const owner = promotionOwner();
  const inputScopes: string[] = [], epochs: number[] = [];
  const f = fixture(async () => {
    owner.lease.fencingEpoch++;
    f.input.environmentId = "changed";
  }, {
    assertOwned: async (scope, candidate) => {
      inputScopes.push(scope.environmentId);
      epochs.push(candidate.lease.fencingEpoch);
    },
  });
  const plan = await f.service.readOwnedPlan(f.input, owner);
  expect(plan.environment_id).toBe("production");
  expect(inputScopes).toEqual(["production", "production", "production"]);
  expect(epochs).toEqual([3, 3, 3]);
  expect(JSON.stringify(plan)).not.toContain(owner.lease.leaseToken);
});

for (const noOp of [false, true]) {
  test.each([1, 2, 3, 4, 5, 6])(`busy scope at check %s cannot return a ${noOp ? "no-op" : "promote"} plan`, async busyAt => {
    let checks = 0;
    const f = fixture(async () => {
      if (++checks === busyAt) throw new ApplicationPromotionError("APPLICATION_PROMOTION_BUSY", 409);
    });
    if (noOp) { f.setArtifact(); f.setTarget(active("production")); }
    await expect(f.service.readPlan(f.input)).rejects.toMatchObject({
      code: "APPLICATION_PROMOTION_BUSY", statusCode: 409,
    });
    expect(checks).toBe(busyAt);
    expect(f.reads()).toBe(busyAt <= 2 ? 0 : 1);
  });
}

test("invalid scope does not query the journal and provider lookup failures are redacted", async () => {
  let checks = 0;
  const f = fixture(async () => { checks++; throw new Error("private-credential"); });
  await expect(f.service.readPlan({ ...f.input, sourceProjectRef: "../foreign" })).rejects.toMatchObject({ statusCode: 400 });
  expect(checks).toBe(0);
  await expect(f.service.readPlan(f.input)).rejects.toMatchObject({
    code: "APPLICATION_PROMOTION_UNVERIFIED", message: "APPLICATION_PROMOTION_UNVERIFIED", statusCode: 503,
  });
  expect(f.reads()).toBe(0);
});

test("promotion API returns a busy conflict without a success-shaped plan", async () => {
  const f = fixture(async () => { throw new ApplicationPromotionError("APPLICATION_PROMOTION_BUSY", 409); });
  const routes = createApplicationRoutes({
    projectExists: async () => true, promotions: f.service, authorize: async () => undefined,
  });
  const response = await routes.handle(new Request(
    `http://localhost/v1/projects/production/applications/reviews/environments/production/promotion-plan`
      + `?source_ref=staging&source_environment_id=staging&source_release_id=${f.input.sourceReleaseId}`,
  ));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    code: "APPLICATION_PROMOTION_BUSY", error: "Application promotion plan is unavailable",
  });
  expect(f.reads()).toBe(0);
});

for (const side of ["source", "target"] as const) {
  test.each(["bare-resource", "fingerprint", "missing-checkpoint", "prepared", "configuration-drift", "hosts-drift"] as const)(
    `${side} journal rejects %s instead of accepting a receipt alone`, async fault => {
      const f = fixture(), target = active("production");
      f.setArtifact();
      f.setTarget(target);
      const journal = side === "source" ? f.sourceState : f.targetState;
      const current = side === "source" ? f.source : target;
      expect(journal.resourceKey).toStartWith("v1/application_release/");
      if (fault === "bare-resource") journal.resourceKey = stableSha256({
        applicationId: "reviews", environmentId: current.runtime.environmentId,
      });
      if (fault === "fingerprint") journal.requestFingerprint = "d".repeat(64);
      if (fault === "missing-checkpoint") journal.checkpoint = {};
      if (fault === "prepared") journal.checkpoint["phase"] = "prepared";
      if (fault === "configuration-drift") current.configurationDigest = "e".repeat(64);
      if (fault === "hosts-drift") current.hosts = { api: ["other.example.com"] };
      const plan = await f.service.readPlan(f.input);
      expect(plan[side].receipt_confirmed).toBe(false);
      if (side === "source") {
        expect(plan.action).toBe("blocked");
        expect(plan.blockers).toContain("SOURCE_RECEIPT_UNCONFIRMED");
      } else {
        expect(plan.action).toBe("promote");
      }
    },
  );
}

test.each(["source", "target"] as const)("canonical %s reconciliation remains valid journal evidence", async side => {
  const f = fixture(), target = active("production");
  f.setArtifact();
  f.setTarget(target);
  const journal = side === "source" ? f.sourceState : f.targetState;
  const desired = side === "source" ? f.source : target;
  journal.checkpoint["phase"] = "routed";
  journal.receipt = { reconciliation: {
    source: "project.release.authority", observed_at: new Date(now - 1000).toISOString(),
    evidence_code: "RELEASE_AUTHORITY_CONFIRMED",
    evidence_fingerprint: stableSha256({ schema: "supacloud.application-activation-recovery.v1", desired }),
    target_status: "succeeded",
  } };
  const plan = await f.service.readPlan(f.input);
  expect(plan[side].receipt_confirmed).toBe(true);
  expect(plan.action).toBe("no-op");
});
