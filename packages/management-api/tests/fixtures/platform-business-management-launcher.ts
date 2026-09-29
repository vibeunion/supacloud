import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { SQL } from "bun";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildDeliveryMigrationPlan, readDeliveryExecutableArchive, readDeliveryMigrationArchive,
  type DeliveryMigrationArchive } from "../../../delivery/src";
import { COMMAND_PERSISTENCE_SQL } from "../../../db/src/command-schema";
import { parsePostgresUrl } from "../../src/utils/postgres-url";
import {
  businessManagementFailure, managementResponse,
  requireBusinessManagementProject, runPlatformBusinessManagement, type BusinessManagementInput,
} from "./platform-business-management";
import { runPlatformBusinessWorkflow } from "./platform-business-workflow-smoke";

export function defaultManagementLauncherSettings(env = process.env) {
  assert.equal(env.SUPACLOUD_BUSINESS_MANAGEMENT_TEST, "1", "Explicit management acceptance opt-in required");
  assert.ok(!env.SUPACLOUD_BUSINESS_RESUME_ROOT && env.SUPACLOUD_BUSINESS_RESUME_PROVISIONING !== "1",
    "Provisioning resume is unsupported; retain private inputs for explicit recovery");
  const ref = env.SUPACLOUD_TEST_PROJECT_REF;
  assert.equal(ref, "ttzatqixbiaxhyratbvh", "Dedicated default-management project required");
  for (const key of ["DATABASE_URL", "MASTER_TOKEN", "SUPACLOUD_BUSINESS_ARCHIVE",
    "SUPACLOUD_BUSINESS_VERIFIER", "NODE_EXTRA_CA_CERTS"]) assert.ok(env[key], `Missing ${key}`);
  for (const key of ["SUPACLOUD_BUSINESS_ARCHIVE", "SUPACLOUD_BUSINESS_VERIFIER", "NODE_EXTRA_CA_CERTS"]) {
    assert.ok(isAbsolute(env[key]!), `Absolute ${key} required`);
  }
  const rolePrefix = env.SUPACLOUD_BUSINESS_ROLE_PREFIX ?? `starter_${ref}`;
  assert.match(rolePrefix, /^[a-z_][a-z0-9_]{0,49}$/, "Invalid role prefix");
  return {
    ref, manifestPath: env.SUPACLOUD_BUSINESS_ARCHIVE!, verifier: env.SUPACLOUD_BUSINESS_VERIFIER!,
    caPath: env.NODE_EXTRA_CA_CERTS!, databaseUrl: env.DATABASE_URL!, managementToken: env.MASTER_TOKEN!,
    rolePrefix,
  };
}

export function managementAcceptanceDatabaseOptions(url: string): SQL.Options {
  return { adapter: "postgres", url, ...parsePostgresUrl(url), max: 1, connectionTimeout: 5 };
}

export function managementSetupMigrationPlan(archive: DeliveryMigrationArchive,
  inventory: Parameters<typeof buildDeliveryMigrationPlan>[1], ref: string, resume: boolean) {
  assert.ok(resume || inventory.length === 0, "Existing setup requires explicit SUPACLOUD_BUSINESS_RESUME_SETUP=1");
  const plan = buildDeliveryMigrationPlan(archive, inventory, ref);
  assert.ok(plan.ledgerCompatible, "Setup ledger conflicts with the immutable archive");
  assert.ok(inventory.every(row => plan.migrations.some(entry =>
    entry.version === row.version && entry.status === "ledger-match")), "Unexpected migration in setup inventory");
  return plan;
}

export function assertStarterStorageBucket(bucket: {
  public?: unknown;
  file_size_limit?: unknown;
  allowed_mime_types?: unknown;
}) {
  assert.equal(bucket.public, false);
  assert.equal(Number(bucket.file_size_limit), 1048576);
  assert.deepEqual(bucket.allowed_mime_types, ["text/plain"]);
}

async function oauthToken(client: SupabaseClient, issuer: string, clientId: string, callback: string) {
  const verifier = randomBytes(32).toString("base64url"), state = crypto.randomUUID();
  const authorize = new URL(`${issuer}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: clientId, redirect_uri: callback, response_type: "code", scope: "openid email profile",
    state, nonce: crypto.randomUUID(), code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const response = await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 302);
  const authorizationId = new URL(response.headers.get("location")!).searchParams.get("authorization_id")!;
  assert.ok(authorizationId);
  const details = await client.auth.oauth.getAuthorizationDetails(authorizationId);
  assert.ok(!details.error && details.data);
  const location = "redirect_url" in details.data ? details.data.redirect_url
    : (await client.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })).data?.redirect_url;
  assert.ok(location);
  const redirect = new URL(location);
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get("state"), state);
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  const exchanged = await fetch(`${issuer}/oauth/token`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      redirect_uri: callback, code, code_verifier: verifier }),
  });
  assert.equal(exchanged.status, 200);
  const result = await exchanged.json();
  assert.ok(typeof result.access_token === "string" && result.access_token.length > 0);
  return result.access_token as string;
}

/** Fresh dedicated tenant only. Retain private inputs and dependencies on uncertain outcomes. */
export async function runDefaultManagementLauncher(env = process.env) {
  const settings = defaultManagementLauncherSettings(env);
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid?.(), 0);
  assert.equal(hostname(), "supacloud-delivery-acceptance-0926");
  const { ref } = settings;
  const runtimeGroups = { http: `${settings.rolePrefix}_http`, worker: `${settings.rolePrefix}_worker` };
  const request = async (suffix: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:9090/v1/projects/${ref}${suffix}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(120000),
      headers: { authorization: `Bearer ${settings.managementToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return managementResponse(response);
  };
  assert.ok(requireBusinessManagementProject(await request(""), ref), "Project not ready");
  await readDeliveryExecutableArchive(settings.manifestPath);
  const migrationArchive = await readDeliveryMigrationArchive(settings.manifestPath, "api");
  const migrations = migrationArchive.migrations;
  assert.deepEqual(migrations, (await readDeliveryMigrationArchive(settings.manifestPath, "jobs")).migrations);
  assert.equal(migrations.length, 4);
  const meta = new SQL(managementAcceptanceDatabaseOptions(settings.databaseUrl));
  let database: SQL | undefined;
  const base = "/var/lib/supacloud-delivery-acceptance";
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "default-management-"));
  await chmod(root, 0o700);
  let phase = "tenant-guard";
  const evidence: Record<string, unknown> = {};
  try {
    const [project] = await meta`SELECT ref,name,status,db_name,anon_key,service_role_key
      FROM projects WHERE ref=${ref} AND deleted_at IS NULL`;
    assert.ok(requireBusinessManagementProject(project, ref));
    assert.equal(project.db_name, `supa_${ref}`);
    const inspection = new URL(settings.databaseUrl);
    inspection.pathname = `/${project.db_name}`;
    database = new SQL(managementAcceptanceDatabaseOptions(inspection.href));
    const [identity] = await database`SELECT current_database() AS name`;
    assert.equal(identity.name, project.db_name, "Tenant connection identity mismatch");
    const [lock] = await database`SELECT pg_try_advisory_lock(hashtextextended(
      ${"supacloud.default-management-acceptance"},0)) AS acquired`;
    assert.equal(lock.acquired, true);
    const [existing] = await database`SELECT to_regclass('public.starter_application') AS relation`;
    const inventory = await request("/database/migrations/inventory");
    const migrationPlan = managementSetupMigrationPlan(
      migrationArchive, inventory.migrations, ref, env.SUPACLOUD_BUSINESS_RESUME_SETUP === "1",
    );
    if (existing.relation) {
      assert.equal(env.SUPACLOUD_BUSINESS_RESUME_SETUP, "1");
      const bindings = await database`SELECT project_id,tenant_id FROM public.starter_application`;
      assert.equal(bindings.length, 0, "Provisioned tenant must use retained inputs; never replay activation");
    }
    phase = "command-persistence";
    await database.begin(tx => tx.unsafe(COMMAND_PERSISTENCE_SQL));
    phase = "project-migrations";
    for (const migration of migrations.filter(entry => entry.executor === "project-migration")) {
      const expected = migrationPlan.migrations.find(entry => entry.version === migration.version)!;
      if (expected.status === "ledger-match") continue;
      const applied = await request("/database/migrations", {
        version: migration.version, name: migration.name, sql: migration.sql,
      });
      assert.equal(applied.version, migration.version);
      assert.equal(applied.checksum, expected.ledgerChecksum);
    }
    const readback = await request("/database/migrations/inventory");
    assert.ok(managementSetupMigrationPlan(migrationArchive, readback.migrations, ref, true)
      .migrations.every(entry => entry.status === "ledger-match"));
    phase = "operator-provisioning";
    const reserved = await database`SELECT rolname FROM pg_roles
      WHERE rolname IN (${runtimeGroups.http},${runtimeGroups.worker})`;
    assert.equal(reserved.length, 0, "Existing runtime groups require explicit recovery");
    const roleMigration = migrations.find(entry => entry.executor === "operator-provisioning"
      && entry.name === "review_runtime_roles");
    assert.ok(roleMigration?.sql.includes(`CREATE ROLE ${runtimeGroups.http} `)
      && roleMigration.sql.includes(`CREATE ROLE ${runtimeGroups.worker} `), "Build a project-scoped role archive");
    await database.begin(async tx => {
      for (const migration of migrations.filter(entry => entry.executor === "operator-provisioning")) {
        await tx.unsafe(migration.sql);
      }
      await tx`INSERT INTO public.starter_application(project_id,tenant_id)
        VALUES (${ref},${`business-${ref}`})`;
    });
    const origin = `https://${ref}.api.localhost`, issuer = `${origin}/auth/v1`;
    const sdkOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    const admin = createClient(origin, project.service_role_key, sdkOptions);
    phase = "storage-bucket";
    const existingBucket = await admin.storage.getBucket("review-attachments");
    evidence.storageBucket = existingBucket.error
      ? { status: existingBucket.error.status }
      : {
        public: existingBucket.data?.public,
        file_size_limit: existingBucket.data?.file_size_limit,
        allowed_mime_types: existingBucket.data?.allowed_mime_types,
      };
    if (existingBucket.error) {
      assert.match(String(existingBucket.error.message), /not found|does not exist/i);
      const bucket = await admin.storage.createBucket("review-attachments", {
        public: false, fileSizeLimit: 1048576, allowedMimeTypes: ["text/plain"],
      });
      assert.equal(bucket.error, null);
    } else {
      assertStarterStorageBucket(existingBucket.data ?? {});
    }
    phase = "oauth-client";
    const callback = "https://acceptance.example.com/callback";
    const client = await request("/auth/oauth-clients", {
      client_name: `default-management-${crypto.randomUUID()}`, client_type: "public",
      token_endpoint_auth_method: "none", redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
    });
    assert.ok(typeof client.client_id === "string");
    const clientId = client.client_id;
    const tokens: string[] = [];
    const workerId = `management-${crypto.randomUUID()}`;
    evidence.clientId = clientId;
    const subjects: string[] = [];
    evidence.subjects = subjects;
    phase = "gotrue-identity";
    for (const kind of ["owner", "other"]) {
      const email = `management-${kind}-${crypto.randomUUID()}@example.com`;
      const password = `${randomBytes(32).toString("hex")}Aa1!`;
      const signup = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      assert.ok(!signup.error && signup.data.user);
      subjects.push(signup.data.user.id);
      const sdk = createClient(origin, project.anon_key, sdkOptions);
      const login = await sdk.auth.signInWithPassword({ email, password });
      assert.ok(!login.error && login.data.user?.id === signup.data.user.id);
      tokens.push(await oauthToken(sdk, issuer, clientId, callback));
      await database`INSERT INTO public.starter_members(subject,can_approve,storage_subject)
        VALUES (${signup.data.user.id},true,${signup.data.user.id}::uuid)`;
    }
    phase = "runtime-roles";
    const connections: Record<string, string> = {};
    const roles: string[] = [];
    evidence.roles = roles;
    for (const kind of ["http", "worker"] as const) {
      const role = `${settings.rolePrefix}_login_${kind}`;
      const password = randomBytes(32).toString("hex");
      // CREATE fails on collisions; never adopt or rotate an existing LOGIN.
      await database.unsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD '${password}' IN ROLE ${runtimeGroups[kind]}`);
      roles.push(role);
      await database.unsafe(`GRANT CONNECT ON DATABASE "supa_${ref}" TO "${role}"`);
      const url = new URL(inspection);
      url.username = role;
      url.password = password;
      connections[kind] = url.href;
    }
    const common = {
      NODE_EXTRA_CA_CERTS: settings.caPath, NO_PROXY: "*", APP_TENANT_ID: `business-${ref}`,
      SUPACLOUD_PROJECT_ID: ref, SUPACLOUD_URL: origin, SUPACLOUD_SERVICE_ROLE_KEY: String(project.service_role_key),
    };
    const input: BusinessManagementInput = {
      ref, manifestPath: settings.manifestPath, verifierExecutable: settings.verifier, expectedRevision: 1,
      ownerToken: tokens[0]!, managementToken: settings.managementToken,
      inspectionDatabaseUrl: inspection.href, ca: await readFile(settings.caPath, "utf8"),
      runtimeGroups,
      privateReceiptPath: join(root, "private-effects.json"),
      environment: {
        api: { ...common, DATABASE_URL: connections.http!, REVIEW_ATTACHMENTS: "enabled",
          SUPAUTH_ISSUER: issuer, SUPAUTH_AUDIENCE: "authenticated", SUPAUTH_CLIENT_ID: clientId,
          SUPAUTH_JWKS_URL: `${issuer}/.well-known/jwks.json` },
        jobs: { ...common, DATABASE_URL: connections.worker!, REVIEW_QUEUE_OWNERSHIP: "exclusive-review-attachments",
          REVIEW_WORKER_ID: workerId },
      },
    };
    await writeFile(join(root, "private-input.json"), JSON.stringify({ input, otherToken: tokens[1] }), { mode: 0o600, flag: "wx" });
    phase = "default-activation";
    const activation = await runPlatformBusinessManagement(input);
    evidence.activation = activation;
    if (activation.status !== "PASS") {
      const receipt = { status: "PARTIAL", phase, evidence, root };
      await writeFile(join(root, "receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
      return receipt;
    }
    phase = "gateway-business-workflow";
    evidence.business = await runPlatformBusinessWorkflow({
      ...env, SUPACLOUD_BUSINESS_WORKFLOW_TEST: "1",
      SUPACLOUD_BUSINESS_ORIGIN: `https://${activation.host}`, SUPACLOUD_BUSINESS_TENANT_ID: `business-${ref}`,
      SUPACLOUD_BUSINESS_CLIENT_ID: clientId, SUPACLOUD_BUSINESS_WORKER_ID: workerId,
      SUPACLOUD_BUSINESS_OWNER_TOKEN: tokens[0]!, SUPACLOUD_BUSINESS_OTHER_TOKEN: tokens[1]!,
    });
    const receipt = { status: "PASS", scope: "default-management-first-activation-and-business", evidence, root };
    await writeFile(join(root, "receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
    return receipt;
  } catch (error) {
    const receipt = { ...businessManagementFailure(error, phase, { project_ref: ref }), root,
      retention: "Retain all dependencies and private inputs; do not replay uncertain effects." };
    await writeFile(join(root, "receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
    return receipt;
  } finally {
    await database?.close({ timeout: 2 });
    await meta.close({ timeout: 2 });
  }
}

if (import.meta.main) {
  try {
    const receipt = await runDefaultManagementLauncher();
    console.log(JSON.stringify(receipt));
    process.exitCode = receipt.status === "PASS" ? 0 : 1;
  } catch {
    console.error("DEFAULT_MANAGEMENT_ACCEPTANCE_PREFLIGHT_FAILED");
    process.exitCode = 1;
  }
}
