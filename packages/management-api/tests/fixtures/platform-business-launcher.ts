import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readDeliveryExecutableArchive, readDeliveryMigrationArchive } from "../../../delivery/src";
import { COMMAND_PERSISTENCE_SQL } from "../../../db/src/command-schema";
import { ApplicationReleaseStorage } from "../../src/services/application-release-storage";
import { ApplicationRuntimeFiles } from "../../src/services/application-runtime-files";
import { ApplicationSystemdRuntime, applicationRuntimePlan, type ApplicationRuntimeInput } from "../../src/services/application-runtime";
import { ApplicationReadiness } from "../../src/services/application-readiness";
import { removeManagedSystemdUnit } from "../../src/services/systemd-unit-broker";
import { runPlatformBusinessWorkflow } from "./platform-business-workflow-smoke";

const failureCodes = new Set([
  "ERR_ASSERTION", "ENOENT", "EACCES", "ECONNREFUSED", "ETIMEDOUT",
  "42501", "42703", "42701", "42P07", "28P01", "08006", "23505", "40001", "57014",
  "BUSINESS_MIGRATION_PARTIAL", "BUSINESS_UPGRADE_REFUSAL_UNCONFIRMED", "BUSINESS_JOURNAL_UNAVAILABLE",
  "BUSINESS_FIXTURE_FAILED", "BUSINESS_ACCEPTANCE_CLEANUP_FAILED", "APPLICATION_NOT_READY",
  "APPLICATION_RUNTIME_START_FAILED", "APPLICATION_RUNTIME_STOP_FAILED",
  "APPLICATION_RUNTIME_STOP_UNCONFIRMED", "APPLICATION_RUNTIME_OBSERVATION_FAILED",
]);

export function limitedFailure(error: unknown) {
  const item = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const names = new Set(["Error", "AssertionError", "TypeError", "PostgresError", "TimeoutError", "ApplicationReadinessError"]);
  const code = [item.code, item.errno, item.message].find(value => typeof value === "string" && failureCodes.has(value));
  return {
    name: typeof item.name === "string" && names.has(item.name) ? item.name : "Error",
    code: typeof code === "string" ? code : "UNKNOWN_ERROR",
  };
}

interface MigrationColumn {
  table_name: string; column_name: string; data_type: string;
  column_default: string | null; is_nullable: string;
}

export function classifyBusinessMigration(columns: readonly MigrationColumn[]): "absent" | "applied" {
  if (columns.length === 0) return "absent";
  const delivery = columns.find(row => row.table_name === "starter_application" && row.column_name === "delivery_revision");
  const writer = columns.find(row => row.table_name === "starter_attachment_results" && row.column_name === "writer_revision");
  if (columns.length === 2 && delivery?.data_type === "integer" && delivery.column_default === "2"
    && delivery.is_nullable === "NO" && writer?.data_type === "text"
    && writer.column_default === "'v1'::text" && writer.is_nullable === "NO") return "applied";
  throw Object.assign(new Error("BUSINESS_MIGRATION_PARTIAL"), { code: "BUSINESS_MIGRATION_PARTIAL" });
}

export function hasSchemaRefusal(text: string, unit: string, invocation: string): boolean {
  return text.split("\n").some(line => {
    try {
      const entry = JSON.parse(line);
      if (entry._SYSTEMD_UNIT !== unit || entry._SYSTEMD_INVOCATION_ID !== invocation
        || !/^[1-9][0-9]*$/.test(entry._PID) || typeof entry.MESSAGE !== "string") return false;
      const message = JSON.parse(entry.MESSAGE);
      return message.event === "reference-schema-rejected" && message.reason === "missing-revision";
    } catch { return false; }
  });
}

interface BusinessReceipt {
  label: string; reviewId: string; artifactId: string; durableResult: Record<string, unknown>;
}

interface BusinessResultRow {
  review_id: string; artifact_id: string; version: number; result: unknown; writer_revision: string;
}

export function verifyBusinessResult(
  receipt: BusinessReceipt, rows: readonly BusinessResultRow[], revision: string,
) {
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.result, receipt.durableResult);
  assert.equal(rows[0]?.review_id, receipt.reviewId);
  assert.equal(rows[0]?.artifact_id, receipt.artifactId);
  assert.equal(rows[0]?.version, receipt.durableResult.version);
  assert.equal(rows[0]?.writer_revision, revision);
  assert.equal(receipt.durableResult.reviewId, receipt.reviewId);
  assert.equal(receipt.durableResult.artifactId, receipt.artifactId);
}

export async function runPlatformBusinessLauncher() {
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 0);
assert.equal(process.env.SUPACLOUD_BUSINESS_WORKFLOW_TEST, "1");
const ref = process.env.SUPACLOUD_TEST_PROJECT_REF!;
assert.match(ref, /^[a-z0-9]{10,20}$/);
assert.ok(process.env.DATABASE_URL && process.env.MASTER_TOKEN && process.env.SUPACLOUD_BUSINESS_ARCHIVE);
assert.ok(process.env.NODE_EXTRA_CA_CERTS, "Trust the dedicated Caddy test CA explicitly");
const manifest = process.env.SUPACLOUD_BUSINESS_ARCHIVE;
await readDeliveryExecutableArchive(manifest);
const migrations = await readDeliveryMigrationArchive(manifest, "api");
assert.deepEqual(migrations.migrations, (await readDeliveryMigrationArchive(manifest, "jobs")).migrations);
assert.equal(migrations.migrations.length, 4);
const tenantId = `business-${ref}`;
const meta = new SQL(process.env.DATABASE_URL, { max: 1 });
let db: SQL | undefined;
let clientId: string | undefined;
let active: ApplicationRuntimeInput | undefined;
const installed: ApplicationRuntimeInput[] = [];
const roleNames: string[] = [];
const runtime = new ApplicationSystemdRuntime();
const readiness = new ApplicationReadiness();
const evidence: Record<string, unknown> = { scope: "systemd-starter-http-worker-real-platform-services" };
let phase = "preflight";
let failure: unknown;
const receipts: BusinessReceipt[] = [];
await mkdir("/var/lib/supacloud-delivery-acceptance", { recursive: true });
const root = await mkdtemp("/var/lib/supacloud-delivery-acceptance/business-run-");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const management = (method: string, suffix: string, body?: unknown) =>
  fetch(`http://127.0.0.1:9090/v1/projects/${ref}/auth/oauth-clients${suffix}`, {
    method, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${process.env.MASTER_TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
try {
  const [project] = await meta`SELECT name, db_name, anon_key, service_role_key FROM projects
    WHERE ref=${ref} AND deleted_at IS NULL`;
  assert.ok(project?.name.startsWith("platform-app-acceptance-"));
  assert.equal(project.db_name, `supa_${ref}`);
  const u = new URL(process.env.DATABASE_URL);
  db = new SQL({
    hostname: u.hostname, port: Number(u.port || 5432), username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password), database: project.db_name, max: 1, connectionTimeout: 5,
  });
  const [lock] = await db`SELECT pg_try_advisory_lock(hashtextextended(${"supacloud.business-launcher"},0)) AS acquired`;
  assert.equal(lock?.acquired, true);
  const [queue] = await db`SELECT count(*)::int AS count FROM pgmq.q_supacloud_internal_workflows`;
  assert.equal(queue?.count, 0, "Dedicated Workflow queue must be idle");
  phase = "provisioning";
  const [existing] = await db`SELECT to_regclass('public.starter_application') AS relation`;
  if (!existing?.relation) {
    await db.begin(async tx => {
      await tx.unsafe(COMMAND_PERSISTENCE_SQL);
      for (const migration of migrations.migrations) await tx.unsafe(migration.sql);
      await tx`INSERT INTO public.starter_application(project_id,tenant_id) VALUES (${ref},${tenantId})`;
      await tx.unsafe("COMMENT ON TABLE public.starter_application IS 'supacloud-platform-business-fixture-v1'");
    });
  } else {
    const [owned] = await db`SELECT project_id,tenant_id,
      obj_description('public.starter_application'::regclass) AS marker FROM public.starter_application`;
    assert.deepEqual(owned, { project_id: ref, tenant_id: tenantId, marker: "supacloud-platform-business-fixture-v1" });
  }
  const origin = `https://${ref}.api.localhost`;
  const issuer = `${origin}/auth/v1`;
  const sdkOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const admin = createClient(origin, project.service_role_key, sdkOptions);
  phase = "provisioning:storage";
  const bucket = await admin.storage.createBucket("review-attachments", {
    public: false, fileSizeLimit: 1048576, allowedMimeTypes: ["text/plain"],
  });
  assert.equal(bucket.error, null, "Provision the physical starter bucket through Storage");
  const callback = "https://acceptance.example.com/callback";
  const created = await management("POST", "", {
    client_name: `business-${crypto.randomUUID()}`, client_type: "public",
    token_endpoint_auth_method: "none", redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"],
  });
  assert.equal(created.status, 201, "OAuth client creation failed");
  clientId = (await created.json()).client_id;
  assert.ok(clientId);
  async function token(sdk: SupabaseClient): Promise<string> {
    const verifier = randomBytes(32).toString("base64url");
    const state = crypto.randomUUID();
    const authorize = new URL(`${issuer}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      client_id: clientId!, redirect_uri: callback, response_type: "code", scope: "openid email profile",
      state, nonce: crypto.randomUUID(), code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const response = await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 302);
    const authorizationId = new URL(response.headers.get("location")!).searchParams.get("authorization_id")!;
    const details = await sdk.auth.oauth.getAuthorizationDetails(authorizationId);
    assert.ok(!details.error && details.data);
    const location = "redirect_url" in details.data ? details.data.redirect_url
      : (await sdk.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })).data?.redirect_url;
    assert.ok(location);
    const redirect = new URL(location);
    assert.equal(redirect.searchParams.get("state"), state);
    const exchanged = await fetch(`${issuer}/oauth/token`, {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId!,
        redirect_uri: callback, code: redirect.searchParams.get("code")!, code_verifier: verifier }),
    });
    assert.equal(exchanged.status, 200);
    const result = await exchanged.json();
    assert.ok(typeof result.access_token === "string");
    return result.access_token;
  }
  phase = "identity";
  const tokens: string[] = [];
  const userIds: string[] = [];
  for (const kind of ["owner", "other"]) {
    const email = `business-${kind}-${crypto.randomUUID()}@example.com`, password = `${randomBytes(24).toString("base64url")}Aa1!`;
    const signup = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ok(!signup.error && signup.data.user, "Acceptance user creation failed");
    const sdk = createClient(origin, project.anon_key, sdkOptions);
    const login = await sdk.auth.signInWithPassword({ email, password });
    assert.ok(!login.error && login.data.user?.id === signup.data.user.id, "GoTrue login failed");
    const id = signup.data.user.id;
    userIds.push(id);
    tokens.push(await token(sdk));
    await db`INSERT INTO public.starter_members(subject,can_approve,storage_subject) VALUES (${id},true,${id}::uuid)`;
  }
  evidence.userIds = userIds;
  const connections: Record<string, string> = {};
  for (const kind of ["http", "worker"]) {
    const name = `business_${kind}_${crypto.randomUUID().replaceAll("-", "").slice(0,12)}`;
    const password = randomBytes(32).toString("hex");
    await db.unsafe(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD ${quote(password)} IN ROLE starter_review_${kind}`);
    roleNames.push(name);
    await db.unsafe(`GRANT CONNECT ON DATABASE "supa_${ref}" TO "${name}"`);
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = `/${project.db_name}`;
    url.username = name;
    url.password = password;
    connections[kind] = url.href;
  }
  const storage = new ApplicationReleaseStorage(join(root, "releases"));
  const files = new ApplicationRuntimeFiles(storage);
  const common = {
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, NO_PROXY: "*",
    APP_TENANT_ID: tenantId, SUPACLOUD_PROJECT_ID: ref,
    SUPACLOUD_URL: origin, SUPACLOUD_SERVICE_ROLE_KEY: String(project.service_role_key),
  };
  const workerId = `business-${crypto.randomUUID()}`;
  async function stage(manifestPath: string, label: string) {
    phase = `${label}:runtime`;
    if (active) await runtime.stop(active);
    const selected = await readDeliveryExecutableArchive(manifestPath);
    const release = await storage.importRelease({
      projectRef: ref, applicationId: "business-acceptance", manifestPath,
      expectedObjects: Object.fromEntries(selected.objects.map(({ object }) => [object.name, object.objectId])),
    });
    const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = socket.port!;
    await socket.stop(true);
    active = { release, activationId: crypto.randomUUID(), environmentId: "acceptance", ports: { api: port } };
    installed.push(active);
    await files.prepare(active, {
      api: { ...common, DATABASE_URL: connections.http!, REVIEW_ATTACHMENTS: "enabled",
        SUPAUTH_ISSUER: issuer, SUPAUTH_AUDIENCE: "authenticated", SUPAUTH_CLIENT_ID: clientId!,
        SUPAUTH_JWKS_URL: `${issuer}/.well-known/jwks.json` },
      jobs: { ...common, DATABASE_URL: connections.worker!, REVIEW_QUEUE_OWNERSHIP: "exclusive-review-attachments",
        REVIEW_WORKER_ID: workerId },
    });
    await runtime.install(active);
    await runtime.start(active);
    const ready = await readiness.requireReady(active);
    assert.ok(ready.ready);
    phase = `${label}:business`;
    const receipt = await runPlatformBusinessWorkflow({
      ...process.env, SUPACLOUD_BUSINESS_ARCHIVE: manifestPath,
      SUPACLOUD_BUSINESS_ORIGIN: `http://127.0.0.1:${port}`, SUPACLOUD_BUSINESS_TENANT_ID: tenantId,
      SUPACLOUD_BUSINESS_CLIENT_ID: clientId!, SUPACLOUD_BUSINESS_WORKER_ID: workerId,
      SUPACLOUD_BUSINESS_OWNER_TOKEN: tokens[0]!, SUPACLOUD_BUSINESS_OTHER_TOKEN: tokens[1]!,
    });
    assert.equal(receipt.apiObjectId, release.targets.find(target => target.name === "api")?.object_id);
    assert.equal(receipt.jobsObjectId, release.targets.find(target => target.name === "jobs")?.object_id);
    assert.equal(receipt.status, "PASS");
    assert.equal(typeof receipt.reviewId, "string");
    assert.equal(typeof receipt.artifactId, "string");
    assert.ok(receipt.durableResult && typeof receipt.durableResult === "object");
    receipts.push({
      label, reviewId: receipt.reviewId, artifactId: receipt.artifactId,
      durableResult: receipt.durableResult,
    });
    evidence[label] = { readiness: ready, receipt, runtimeProvenance: "verified-systemd-object-identity" };
  }
  async function expectUpgradeRefused(manifestPath: string) {
    phase = "upgrade:pre-migration-refusal";
    if (active) await runtime.stop(active);
    const selected = await readDeliveryExecutableArchive(manifestPath);
    const release = await storage.importRelease({
      projectRef: ref, applicationId: "business-acceptance", manifestPath,
      expectedObjects: Object.fromEntries(selected.objects.map(({ object }) => [object.name, object.objectId])),
    });
    const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = socket.port!;
    await socket.stop(true);
    const candidate: ApplicationRuntimeInput = {
      release, activationId: crypto.randomUUID(), environmentId: "acceptance", ports: { api: port },
    };
    installed.push(candidate);
    const env = {
      ...common, DATABASE_URL: connections.http!, REVIEW_ATTACHMENTS: "enabled",
      SUPAUTH_ISSUER: issuer, SUPAUTH_AUDIENCE: "authenticated", SUPAUTH_CLIENT_ID: clientId!,
      SUPAUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
    };
    const refusal: Record<string, { objectId: string; invocationId: string }> = {};
    try {
      await files.prepare(candidate, { api: env, jobs: {
        ...common, DATABASE_URL: connections.worker!, REVIEW_QUEUE_OWNERSHIP: "exclusive-review-attachments",
        REVIEW_WORKER_ID: workerId,
      }});
      await runtime.install(candidate);
      try {
        await runtime.start(candidate);
      } catch (error) {
        // A failed start alone is not schema-refusal evidence.
        evidence.upgradeCandidateStart = limitedFailure(error);
      }
      const plan = applicationRuntimePlan(candidate);
      assert.deepEqual(plan.targets.map(target => target.name).sort(), ["api", "jobs"]);
      const deadline = Date.now() + 15000;
      while (Object.keys(refusal).length !== plan.targets.length) {
        for (const state of await runtime.inspect(candidate)) {
          if (refusal[state.target] || state.processRunning || state.mainPid !== 0
            || state.result !== "exit-code" || !state.invocationId) continue;
          const child = Bun.spawn({
            cmd: ["journalctl", "--no-pager", "--output=json", "--lines=16",
              "--output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID",
              "--grep=reference-schema-rejected", `_SYSTEMD_UNIT=${state.unit}`,
              `_SYSTEMD_INVOCATION_ID=${state.invocationId}`],
            stdout: "pipe", stderr: "ignore",
          });
          const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
          try {
            const text = await new Response(child.stdout).text();
            if (await child.exited !== 0 || text.length > 65536) {
              throw new Error("BUSINESS_JOURNAL_UNAVAILABLE");
            }
            if (hasSchemaRefusal(text, state.unit, state.invocationId)) {
              refusal[state.target] = {
                objectId: plan.targets.find(target => target.name === state.target)!.objectId,
                invocationId: state.invocationId,
              };
            }
          } finally {
            clearTimeout(timeout);
            if (child.exitCode === null) child.kill("SIGKILL");
            await child.exited;
          }
        }
        if (Object.keys(refusal).length === plan.targets.length) break;
        if (Date.now() >= deadline) throw new Error("BUSINESS_UPGRADE_REFUSAL_UNCONFIRMED");
        await Bun.sleep(100);
      }
      evidence.upgradeRefusal = { status: "PASS", reason: "missing-revision", targets: refusal };
    } finally {
      await runtime.stop(candidate);
    }
  }
  const migrationState = async (connection: SQL) => {
    const rows: MigrationColumn[] =
      await connection`SELECT table_name,column_name,data_type,column_default,is_nullable
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('starter_application','starter_attachment_results')
          AND ((table_name='starter_application' AND column_name='delivery_revision')
            OR (table_name='starter_attachment_results' AND column_name='writer_revision'))`;
    const state = classifyBusinessMigration(rows);
    if (state === "applied") {
      const revisions = await connection`SELECT delivery_revision FROM public.starter_application WHERE singleton`;
      if (revisions.length !== 1 || revisions[0]?.delivery_revision !== 2) {
        throw new Error("BUSINESS_MIGRATION_PARTIAL");
      }
    }
    return state;
  };
  async function verifyBusinessHistory() {
    assert.equal(receipts.length, 3);
    assert.deepEqual(receipts.map(receipt => receipt.label), ["original", "upgraded", "rollback"]);
    assert.equal(new Set(receipts.map(receipt => receipt.reviewId)).size, 3);
    assert.equal(new Set(receipts.map(receipt => receipt.artifactId)).size, 3);
    const expectedRevisions = ["v1", "v2", "v1"];
    for (let index = 0; index < receipts.length; index++) {
      const receipt = receipts[index]!;
      const rows: BusinessResultRow[] = await db!`
        SELECT review_id,artifact_id::text,version,result,writer_revision
        FROM public.starter_attachment_results WHERE review_id=${receipt.reviewId}
      `;
      verifyBusinessResult(receipt, rows, expectedRevisions[index]!);
    }
    evidence.rollbackPreservedData = true;
  }
  await stage(manifest, "original");
  if (process.env.SUPACLOUD_BUSINESS_UPGRADED_ARCHIVE) {
    const path = process.env.SUPACLOUD_BUSINESS_UPGRADED_ARCHIVE;
    const upgrade = await readDeliveryMigrationArchive(path, "api");
    const migration = upgrade.migrations.find(item => item.version === "5");
    assert.ok(migration && migration.executor === "project-migration");
    assert.deepEqual(upgrade.migrations, (await readDeliveryMigrationArchive(path, "jobs")).migrations);
    assert.equal(upgrade.migrations.length, migrations.migrations.length + 1);
    assert.deepEqual(upgrade.migrations.slice(0, -1), migrations.migrations);
    assert.equal(upgrade.migrations.at(-1)?.version, "5");
    const beforeMigration = await migrationState(db);
    if (beforeMigration === "absent") await expectUpgradeRefused(path);
    else evidence.upgradeRefusal = { status: "NOT_RUN", reason: "schema-already-applied" };
    phase = "upgrade:migration";
    await runtime.stop(active!);
    if (beforeMigration === "absent") {
      await db.begin(async tx => {
        assert.equal(await migrationState(tx), "absent");
        await tx.unsafe(migration.sql);
        assert.equal(await migrationState(tx), "applied");
      });
      evidence.migration = { status: "applied-and-verified", sha256: migration.sha256 };
    } else {
      evidence.migration = { status: "already-applied-schema-verified", executionPerformed: false,
        requestedSha256: migration.sha256 };
    }
    await stage(path, "upgraded");
    await stage(manifest, "rollback");
    await verifyBusinessHistory();
  }
} catch (error) {
  failure = error;
  if (error && typeof error === "object" && "code" in error
    && error.code === "BUSINESS_FIXTURE_FAILED" && "businessEvidence" in error) {
    evidence.businessFailure = error.businessEvidence;
  }
} finally {
  const cleanup: string[] = [];
  for (const input of installed) {
    try {
      await runtime.stop(input);
      await runtime.requireStopped(input);
      for (const target of applicationRuntimePlan(input).targets) await removeManagedSystemdUnit(target.unit);
    } catch { cleanup.push("runtime"); }
  }
  if (clientId) {
    try {
      const removed = await management("DELETE", `/${clientId}`);
      assert.ok(removed.ok || removed.status === 404);
      assert.equal((await management("GET", `/${clientId}`)).status, 404);
    } catch { cleanup.push("oauth-client"); }
  }
  for (const name of roleNames) {
    try { await db?.unsafe(`ALTER ROLE "${name}" NOLOGIN PASSWORD NULL`); }
    catch { cleanup.push("runtime-login"); }
    try { await db?.unsafe(`REVOKE CONNECT ON DATABASE "supa_${ref}" FROM "${name}"`); }
    catch { cleanup.push("runtime-connect"); }
  }
  try { await db?.close(); } catch { cleanup.push("tenant-connection"); }
  try { await meta.close(); } catch { cleanup.push("metadata-connection"); }
  if (cleanup.length) failure ??= new Error("BUSINESS_ACCEPTANCE_CLEANUP_FAILED");
  const result = { status: failure ? "FAIL" : "PASS", phase, root, evidence,
    ...(failure ? { failure: limitedFailure(failure) } : {}), cleanup,
    retention: "owned-business-data-and-immutable-artifacts-retained",
    remaining: ["default-management-activation", "application-gateway", "independent-data-recovery", "live-supauth-rbac"] };
  await writeFile(join(root, "receipt.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
if (failure) process.exitCode = 1;
}

if (import.meta.main) {
  try { await runPlatformBusinessLauncher(); }
  catch (error) {
    console.error(JSON.stringify({ status: "FAIL", failure: limitedFailure(error) }));
    process.exitCode = 1;
  }
}
