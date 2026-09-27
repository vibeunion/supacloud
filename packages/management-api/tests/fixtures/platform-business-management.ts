import assert from "node:assert/strict";
import { SQL } from "bun";
import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationReleaseId, parseApplicationConfigurationWrite, parseApplicationReadinessReport,
  parseApplicationReleaseRecord, parseApplicationRuntimeIdentity, readDeliveryExecutableArchive,
  type ApplicationReleaseRecord,
} from "../../../delivery/src";
import { parsePostgresUrl } from "../../src/utils/postgres-url";
import { stableSha256 } from "../../src/utils/stable-json";
import type { StarterCompatibilityPolicy } from "../../src/services/application-starter-compatibility";

export interface BusinessManagementInput {
  ref: string;
  manifestPath: string;
  environment: { api: Record<string, string>; jobs: Record<string, string> };
  ownerToken: string;
  inspectionDatabaseUrl: string;
  expectedRevision: 1 | 2;
  verifierExecutable: string;
  managementToken: string;
  applicationId?: string;
  environmentId?: string;
  ca?: string;
}

export function businessManagementSettings(input: BusinessManagementInput, env = process.env) {
  assert.equal(env.SUPACLOUD_BUSINESS_MANAGEMENT_TEST, "1", "Explicit management acceptance opt-in required");
  assert.equal(env.SUPACLOUD_TEST_PROJECT_REF, input.ref, "Owned acceptance project mismatch");
  assert.match(input.ref, /^[a-z0-9]{10,20}$/);
  assert.ok(input.manifestPath && input.verifierExecutable && input.ownerToken && input.managementToken);
  assert.ok(input.expectedRevision === 1 || input.expectedRevision === 2);
  const applicationId = input.applicationId ?? "business-management";
  const environmentId = input.environmentId ?? "acceptance";
  for (const id of [applicationId, environmentId]) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  const inspection = parsePostgresUrl(input.inspectionDatabaseUrl);
  assert.equal(inspection.database, `supa_${input.ref}`, "Inspection must already target the owned tenant");
  for (const target of [input.environment.api, input.environment.jobs]) {
    assert.equal(target.SUPACLOUD_PROJECT_ID, input.ref);
    assert.equal(target.APP_TENANT_ID, `business-${input.ref}`);
    assert.equal(target.SUPACLOUD_URL, `https://${input.ref}.api.localhost`);
    assert.ok(target.DATABASE_URL, "This acceptance helper requires explicit TCP role URLs");
    assert.ok(!target.DATABASE_SOCKET_PATH);
    assert.equal(parsePostgresUrl(target.DATABASE_URL!).database, inspection.database);
  }
  assert.notEqual(parsePostgresUrl(input.environment.api.DATABASE_URL!).username,
    parsePostgresUrl(input.environment.jobs.DATABASE_URL!).username, "Distinct runtime LOGIN roles required");
  const host = `business-${input.ref}.localhost`;
  const configuration = parseApplicationConfigurationWrite({
    configuration_id: crypto.randomUUID(), expected_configuration_id: null,
    configuration: { bun_version: "1.4.2", targets: [
      { name: "api", kind: "http", hosts: [host], environment: input.environment.api },
      { name: "jobs", kind: "worker", hosts: [], environment: input.environment.jobs },
    ] },
  });
  return { applicationId, environmentId, host, configuration, inspection };
}

/** Private output: the launcher must never put this policy in its public receipt/log. */
export function businessManagementVerifierPolicy(
  input: BusinessManagementInput, release: ApplicationReleaseRecord, env = process.env,
): StarterCompatibilityPolicy {
  const settings = businessManagementSettings(input, env);
  const record = parseApplicationReleaseRecord(release);
  assert.equal(record.project_ref, input.ref);
  assert.equal(record.application_id, settings.applicationId);
  assert.deepEqual(record.targets.map(target => [target.name, target.kind]).sort(),
    [["api", "http"], ["jobs", "worker"]]);
  return {
    schema: "supacloud.starter-compatibility-policy.v1", project_ref: input.ref,
    application_id: settings.applicationId, environment_id: settings.environmentId,
    environment_sha256: stableSha256(input.environment),
    releases: [{ manifest_sha256: record.manifest_sha256, revision: input.expectedRevision }],
    database: settings.inspection.database,
    http_role: parsePostgresUrl(input.environment.api.DATABASE_URL!).username,
    worker_role: parsePostgresUrl(input.environment.jobs.DATABASE_URL!).username,
    inspection: { url: input.inspectionDatabaseUrl }, identity_token: input.ownerToken,
    ...(input.ca ? { ca: input.ca } : {}),
  };
}

export function requireBusinessManagementProject(value: unknown, ref: string): boolean {
  assert.ok(value && typeof value === "object");
  const project = value as Record<string, unknown>;
  assert.equal(project.ref, ref);
  assert.ok(typeof project.name === "string" && project.name.startsWith("platform-app-acceptance-default-"),
    "Dedicated default-management acceptance tenant required");
  return typeof project.status === "string" && project.status.toLowerCase() === "active";
}

/** Preserve the API's classification, including platform-inventory out-of-order conflicts. */
export function businessManagementMigrationEvidence(value: unknown) {
  const report = value as Record<string, unknown> | null;
  const statuses = new Set(["ledger-match", "pending", "name-conflict", "checksum-mismatch", "out-of-order"]);
  return {
    ledgerCompatible: report?.ledger_compatible === true,
    projectMigrationsApplied: report?.project_migrations_applied === true,
    migrations: (Array.isArray(report?.targets) ? report.targets : []).flatMap(target =>
      (Array.isArray(target?.migrations) ? target.migrations : []).map((entry: Record<string, unknown>) => ({
        version: typeof entry.version === "string" && /^\d{1,19}$/.test(entry.version) ? entry.version : "invalid",
        status: typeof entry.status === "string" && statuses.has(entry.status) ? entry.status : "invalid",
      }))),
  };
}

export function requireBusinessMigrationLedger(value: unknown): void {
  const report = value as Record<string, unknown> | null;
  if (!report || report.schema !== "supacloud.application-migrations.v1"
    || report.ledger_compatible !== true || report.project_migrations_applied !== true) {
    throw new Error("MIGRATION_ADOPTION_REQUIRED");
  }
}

async function privateInstall(parts: string[], binary: string, policy: StarterCompatibilityPolicy) {
  let directory = "/";
  for (const part of parts) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o755 }).catch(error => {
      if (error?.code !== "EEXIST") throw error;
    });
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022));
  }
  // Never replace an operator's verifier/policy, including after an uncertain run.
  const source = await open(binary, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await source.stat();
    assert.ok(stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022) && stat.size < 300 * 1024 * 1024);
    bytes = await source.readFile();
    assert.equal(bytes.subarray(0, 4).toString("hex"), "7f454c46", "Compiled Linux verifier required");
  } finally { await source.close(); }
  await writeFile(join(directory, "verify"), bytes!, { flag: "wx", mode: 0o755 });
  await writeFile(join(directory, "starter-policy.json"), JSON.stringify(policy), { flag: "wx", mode: 0o600 });
}

/** Real loopback Management API only. No adapters, migration writes or supervisor commands. */
export async function runPlatformBusinessManagement(input: BusinessManagementInput) {
  input = structuredClone(input);
  const settings = businessManagementSettings(input);
  assert.equal(process.platform, "linux", "VM-only fixture");
  assert.equal(process.getuid?.(), 0, "Root required for the private verifier installation");
  const { applicationId, environmentId, host, configuration, inspection } = settings;
  const activationId = crypto.randomUUID();
  const ids = { project_ref: input.ref, application_id: applicationId, environment_id: environmentId,
    activation_id: activationId, configuration_id: configuration.configuration_id };
  let phase = "project-guard";
  let releaseId: string | undefined;
  const database = new SQL({ adapter: "postgres", url: input.inspectionDatabaseUrl, ...inspection,
    max: 1, connectionTimeout: 5 });
  const projectPath = `/v1/projects/${input.ref}`;
  const applicationPath = `${projectPath}/applications/${applicationId}`;
  const environmentPath = `${applicationPath}/environments/${environmentId}`;
  async function call(method: string, path: string, body?: unknown) {
    const multipart = body instanceof FormData;
    const response = await fetch(`http://127.0.0.1:9090${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(120000),
      headers: { authorization: `Bearer ${input.managementToken}`,
        ...(!multipart && body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    });
    assert.ok(response.ok, `Management request failed (${response.status})`);
    return response.json();
  }
  try {
    const project = await call("GET", projectPath);
    if (!requireBusinessManagementProject(project, input.ref)) {
      return { status: "PARTIAL" as const, code: "PROJECT_NOT_ACTIVE", ...ids,
        activationAttempted: false, verifierInstalled: false };
    }
    await database.begin("READ ONLY", async tx => {
      await tx.unsafe("SET LOCAL statement_timeout = '5000ms'");
      const bindings = await tx`SELECT current_database() AS database,project_id,tenant_id
        FROM public.starter_application WHERE singleton`;
      assert.deepEqual(Array.from(bindings), [{ database: inspection.database, project_id: input.ref,
        tenant_id: `business-${input.ref}` }]);
    });
    const runtimeBefore = await call("GET", `${environmentPath}/runtime`);
    assert.equal(runtimeBefore.readiness, null, "Use a fresh management acceptance environment");
    assert.equal((await call("GET", `${environmentPath}/configuration`)).configuration, null);
    phase = "upload";
    const archive = await readDeliveryExecutableArchive(input.manifestPath);
    assert.deepEqual(archive.objects.map(({ object }) => [object.name, object.entryKind]).sort(), [
      ["api", "bun-http-application"], ["jobs", "bun-worker-application"],
    ]);
    const digest = stableSha256(archive.manifest);
    releaseId = applicationReleaseId(input.ref, applicationId, digest);
    const form = new FormData();
    form.set("manifest", JSON.stringify(archive.manifest));
    form.set("expected_objects", JSON.stringify(Object.fromEntries(
      archive.objects.map(({ object }) => [object.name, object.objectId]))));
    for (const { object, files } of archive.objects) {
      for (const [path, bytes] of files) form.set(`objects/${object.objectId}/${path}`, new Blob([Buffer.from(bytes)]), path);
    }
    const uploaded = parseApplicationReleaseRecord((await call("POST", `${applicationPath}/releases`, form)).release);
    assert.equal(uploaded.release_id, releaseId);
    assert.equal(uploaded.manifest_sha256, digest);
    phase = "migration-ledger";
    const report = await call("GET", `${applicationPath}/releases/${releaseId}/migrations`);
    assert.equal(report.project_ref, input.ref);
    assert.equal(report.application_id, applicationId);
    assert.equal(report.release_id, releaseId);
    assert.equal(report.manifest_sha256, digest);
    try { requireBusinessMigrationLedger(report); }
    catch {
      // The baseline endpoint records baseline:<name>, not archived SQL checksums.
      // Existing launcher DDL without a ledger cannot be silently adopted here.
      return { status: "PARTIAL" as const, code: "MIGRATION_ADOPTION_REQUIRED", ...ids, release_id: releaseId,
        activationAttempted: false, verifierInstalled: false,
        migrationEvidence: businessManagementMigrationEvidence(report),
        requirement: "Use a schema-verified adoption flow matching archived SQL checksums, or provision a fresh tenant through canonical migrations. No ledger rows were written." };
    }
    phase = "verifier-install";
    await privateInstall(["etc", "supacloud", "application-verifiers", input.ref, applicationId, environmentId],
      input.verifierExecutable, businessManagementVerifierPolicy(input, uploaded));
    phase = "configuration";
    const stored = await call("PUT", `${environmentPath}/configuration`, configuration);
    assert.equal(stored.configuration.configuration_id, configuration.configuration_id);
    phase = "activation";
    let activationAcknowledged = false;
    try {
      const activated = await call("POST", `${environmentPath}/activations`, {
        activation_id: activationId, release_id: releaseId,
        configuration_id: configuration.configuration_id, expected_activation_id: null,
      });
      assert.equal(activated.activation_id, activationId);
      assert.equal(activated.release_id, releaseId);
      activationAcknowledged = true;
    } catch {
      // A lost receipt is not authorization to replay activation effects.
    }
    phase = "reconcile";
    const reconciled = await call("POST", `${environmentPath}/activations/${activationId}/reconcile`, {});
    for (const [key, value] of Object.entries({ ...ids, release_id: releaseId })) {
      if (key !== "configuration_id") assert.equal(reconciled[key], value);
    }
    phase = "runtime";
    const observed = await call("GET", `${environmentPath}/runtime`);
    assert.equal(observed.configuration_id, configuration.configuration_id);
    const ready = parseApplicationReadinessReport(observed.readiness);
    assert.equal(ready.ready, true);
    assert.equal(ready.project_ref, input.ref);
    assert.equal(ready.application_id, applicationId);
    assert.equal(ready.environment_id, environmentId);
    assert.equal(ready.activation_id, activationId);
    assert.equal(ready.release_id, releaseId);
    assert.deepEqual(ready.targets.map(target => target.target).sort(), ["api", "jobs"]);
    phase = "gateway";
    const response = await fetch(`https://${host}/.well-known/supacloud/runtime`, {
      redirect: "error", signal: AbortSignal.timeout(15000), ...(input.ca ? { tls: { ca: input.ca } } : {}),
    });
    assert.equal(response.status, 200);
    const probe = await response.json();
    assert.equal(probe.ready, true);
    const identity = parseApplicationRuntimeIdentity(probe.identity);
    assert.deepEqual(identity, { schema: "supacloud.application-runtime.v1", project_ref: input.ref,
      application_id: applicationId, environment_id: environmentId, release_id: releaseId,
      activation_id: activationId, target: "api", kind: "http",
      object_id: archive.objects.find(({ object }) => object.name === "api")!.object.objectId,
      pid: ready.targets.find(target => target.target === "api")!.pid });
    return { status: "PASS" as const, ...ids, release_id: releaseId, host, activationAcknowledged,
      defaultComposition: true, reconciled: true, gatewayIdentity: true,
      retention: "Runtime, route, verifier and private policy retained; launcher must not delete their roles/OAuth dependencies." };
  } catch {
    throw new Error(JSON.stringify({ status: "FAIL", phase, ...ids, release_id: releaseId,
      retention: "Retain runtime, route, verifier, policy and dependencies for observation; do not retry blindly." }));
  } finally { await database.close({ timeout: 2 }); }
}
