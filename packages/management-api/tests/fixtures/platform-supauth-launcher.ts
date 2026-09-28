import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, mkdir, rmdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { SQL } from "bun";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { verifyGatewayOAuthPkce } from "./platform-oauth-pkce";

export const TARGET = "ugckmpkijwfbibxtaemr";
export const MACHINE = "supacloud-delivery-acceptance-0926";
export const SOURCE_SHA = "0b321cb09846246e51246927d85dffb78547fdb2";
const facade = "http://127.0.0.1:4010";
const gateway = `https://${TARGET}.api.localhost`;
const callback = "https://acceptance.example.com/supauth-sso";
type Migration = { version: string; name: string; sql: string; checksum: string };
type Artifact = { sourceSha: string; emulatorSha256: string; migrations: Migration[] };
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function databaseOptions(value: string, database?: string) {
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  if (database !== undefined) url.pathname = `/${database}`;
  const name = decodeURIComponent(url.pathname.slice(1));
  assert.ok(url.hostname && url.username && name);
  // Explicit fields prevent ambient PG/DATABASE_URL values selecting another DB.
  return {
    url: url.toString(), hostname: url.hostname, port: Number(url.port || 5432),
    username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: name, max: 1, connectionTimeout: 5,
  };
}
export function ssoEnvironment(email: string, clientId: string) {
  assert.ok(email && !email.includes(",") && clientId);
  const issuer = `${gateway}/auth/v1`;
  return {
    ADMIN_AUTH_MODE: "sso", ADMIN_SSO_ISSUER: issuer,
    ADMIN_SSO_JWKS_URI: `${issuer}/.well-known/jwks.json`,
    ADMIN_SSO_AUDIENCE: "authenticated", ADMIN_SSO_CLIENT_ID: clientId,
    ADMIN_SSO_ALLOWED_EMAILS: email, ADMIN_SSO_ALLOWED_DOMAINS: "",
  };
}
export function ownedOAuthClient(payload: unknown, name: string): string | undefined {
  const rows = Array.isArray(payload) ? payload
    : payload && typeof payload === "object" && "clients" in payload ? payload.clients : undefined;
  assert.ok(Array.isArray(rows), "Invalid OAuth inventory");
  const matches = rows.filter(row => row.client_name === name);
  assert.ok(matches.length <= 1, "Ambiguous test OAuth client");
  const id = matches[0]?.client_id;
  assert.ok(id === undefined || typeof id === "string");
  return id;
}
export async function acquireSsoToken(input: {
  client: SupabaseClient; clientId: string; subject: string; email: string; transport: typeof fetch;
}) {
  const { client, clientId, subject, email, transport } = input;
  const issuer = `${gateway}/auth/v1`;
  const verifier = randomBytes(32).toString("base64url");
  const state = crypto.randomUUID(), nonce = crypto.randomUUID();
  const authorization = new URL(`${issuer}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    client_id: clientId, redirect_uri: callback, response_type: "code", scope: "openid email profile",
    state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const response = await transport(authorization, { redirect: "manual" });
  assert.equal(response.status, 302, "SSO authorization failed");
  const location = response.headers.get("location");
  assert.ok(location);
  const authorizationId = new URL(location).searchParams.get("authorization_id");
  assert.ok(authorizationId);
  const details = await client.auth.oauth.getAuthorizationDetails(authorizationId);
  assert.ok(!details.error && details.data, "SSO consent details unavailable");
  let redirectUrl: string;
  if ("redirect_url" in details.data) {
    redirectUrl = details.data.redirect_url;
  } else {
    assert.equal(details.data.client.id, clientId);
    assert.equal(details.data.user.id, subject);
    const approved = await client.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
    assert.ok(!approved.error && approved.data?.redirect_url, "SSO consent failed");
    redirectUrl = approved.data.redirect_url;
  }
  const redirect = new URL(redirectUrl);
  assert.equal(`${redirect.origin}${redirect.pathname}`, callback);
  assert.equal(redirect.searchParams.get("state"), state);
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  const exchanged = await transport(`${issuer}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId,
      redirect_uri: callback, code, code_verifier: verifier,
    }),
  });
  assert.equal(exchanged.status, 200, "SSO PKCE exchange failed");
  const tokens = await exchanged.json();
  assert.ok(typeof tokens.access_token === "string" && typeof tokens.id_token === "string");
  const jwks = await transport(`${issuer}/.well-known/jwks.json`);
  assert.equal(jwks.status, 200);
  const keys = createLocalJWKSet(await jwks.json());
  const id = await jwtVerify(tokens.id_token, keys, {
    issuer, audience: clientId, algorithms: ["ES256", "RS256"], requiredClaims: ["sub", "exp", "iat", "nonce"],
  });
  assert.equal(id.payload.sub, subject);
  assert.equal(id.payload.nonce, nonce);
  const access = await jwtVerify(tokens.access_token, keys, {
    issuer, audience: "authenticated", algorithms: ["ES256", "RS256"], requiredClaims: ["sub", "exp", "iat", "client_id"],
  });
  assert.equal(access.payload.sub, subject);
  assert.equal(access.payload.email, email);
  assert.equal(access.payload.client_id, clientId);
  assert.equal(access.payload.role, "authenticated");
  return tokens.access_token as string;
}
export function migrationChecksum(m: Pick<Migration, "version" | "name" | "sql">) {
  return hash(JSON.stringify({
    version: m.version, name: m.name.trim(), statements: [m.sql.replace(/\r\n?/g, "\n").trim()],
  }));
}
export function guardTarget(machine: string, platform: string, enabled: string | undefined, project: {
  ref: string; name: string; db_name: string;
}) {
  assert.equal(machine, MACHINE);
  assert.equal(platform, "linux");
  assert.equal(enabled, "1");
  assert.equal(project.ref, TARGET);
  assert.ok(project.name.startsWith("platform-app-acceptance-"));
  assert.equal(project.db_name, `supa_${TARGET}`);
}
export function validateArtifact(artifact: Artifact) {
  assert.equal(artifact.sourceSha, SOURCE_SHA);
  assert.match(artifact.emulatorSha256, /^[a-f0-9]{64}$/);
  const versions = ["1", ...Array.from({ length: 15 }, (_, i) => String(i + 4))];
  assert.deepEqual(artifact.migrations.map(m => m.version), versions);
  for (const m of artifact.migrations) {
    assert.ok(m.name.startsWith("supauth-overlay-") && m.name.endsWith(`-v${m.version}`));
    assert.equal(m.checksum, migrationChecksum(m));
  }
}
export function checkLedger(plan: Migration[], rows: Array<{
  version: string; name: string; statements: string[]; checksum: string;
}>, requireAll: boolean) {
  for (const m of plan) {
    const matches = rows.filter(r => String(r.version) === m.version || r.name === m.name);
    assert.ok(matches.length <= 1, "Ambiguous migration ledger");
    if (!matches.length) {
      assert.ok(!requireAll, "Missing migration receipt");
      continue;
    }
    const r = matches[0]!;
    assert.equal(String(r.version), m.version);
    assert.equal(r.name, m.name);
    assert.equal(r.checksum, m.checksum);
    assert.deepEqual(r.statements, [m.sql.trim()]);
  }
}

// Only fixed stage names/status codes leave this process, never upstream bodies.
export class AcceptanceFailure extends Error {
  constructor(public stage: string, public status?: number, public reason?: string) { super(stage); }
}
export function classifyDenial(body: string): string {
  if (body.includes("The current principal is not an active project collaborator")) return "actor_not_project_collaborator";
  if (body.includes("A valid SupaOAuth BFF proof is required")) return "bff_proof_rejected";
  if (body.includes("Missing collaborator capability")) return "collaborator_capability_missing";
  return "unclassified_upstream_failure";
}
export function safeFailure(error: unknown, stage: string) {
  return {
    stage,
    ...(error instanceof AcceptanceFailure && error.status !== undefined ? { status: error.status } : {}),
    ...(error instanceof AcceptanceFailure && error.reason !== undefined ? { reason: error.reason } : {}),
  };
}
export async function cleanupAll(actions: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const action of actions) {
    try { await action(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AcceptanceFailure("cleanup");
}

export async function runSupAuthAcceptance(directory: string, artifactDigest: string, mode: string) {
  assert.ok(mode === "provision" || mode === "live");
  assert.equal(hostname(), MACHINE);
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid?.(), 0);
  assert.equal(process.env.SUPACLOUD_SUPAUTH_ACCEPTANCE, "1");
  assert.equal(process.env.NO_PROXY, "*");
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    assert.ok(!process.env[key], "Acceptance must not use a proxy");
  }
  const raw = await readFile(join(directory, "artifact.json"));
  assert.match(artifactDigest, /^[a-f0-9]{64}$/);
  assert.equal(hash(raw), artifactDigest);
  const artifact: Artifact = JSON.parse(raw.toString());
  validateArtifact(artifact);
  const emulator = join(directory, "supauth-emulator.js");
  assert.equal(hash(await readFile(emulator)), artifact.emulatorSha256);
  const env = parseEnv(await readFile("/etc/supabase/management-api.env", "utf8"));
  assert.ok(env.DATABASE_URL && env.MASTER_TOKEN);
  const lock = "/run/supacloud-supauth-acceptance.lock";
  await mkdir(lock);
  let metadata: SQL | undefined, tenant: SQL | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined, session: string | undefined;
  let userId: string | undefined, userAttempted = false;
  let collaboratorId: string | undefined, collaboratorAttempted = false;
  let adminOAuthClientId: string | undefined, adminOAuthClientAttempted = false;
  let admin: ReturnType<typeof createClient> | undefined;
  let passwordSession: string | undefined;
  let stage = "metadata";
  const email = `supauth-live-${crypto.randomUUID()}@example.com`;
  const adminOAuthClientName = `supauth-sso-admin-${crypto.randomUUID()}`;
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.on("SIGTERM", interrupted);
  process.on("SIGINT", interrupted);
  const savedEnv = new Map(["MASTER_TOKEN", "SUPACLOUD_SUPAUTH_RBAC_TEST",
    "SUPACLOUD_TEST_SUPAUTH_URL", "SUPACLOUD_TEST_SUPAUTH_BEARER"].map(k => [k, process.env[k]]));
  const evidence: Record<string, unknown> = { scope: "function-emulator", sourceSha: SOURCE_SHA, mode };
  let failed = false;
  let cleaning = false;
  const request = async (base: string, path: string, token: string, method = "GET", body?: unknown) => {
    if (!cleaning) abort.signal.throwIfAborted();
    const response = await fetch(base + path, {
      method, redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: cleaning ? AbortSignal.timeout(30_000) : AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new AcceptanceFailure(stage, response.status, classifyDenial(await response.text()));
    return response;
  };
  const management = (path: string, method = "GET", body?: unknown) =>
    request(`http://127.0.0.1:9090/v1/projects/${TARGET}`, path, env.MASTER_TOKEN!, method, body);
  try {
    const metadataConnection = databaseOptions(env.DATABASE_URL);
    metadata = new SQL(metadataConnection);
    const [metadataIdentity] = await metadata`SELECT current_database() AS name`;
    assert.equal(metadataIdentity.name, metadataConnection.database);
    const [project] = await metadata`
      SELECT ref, name, db_name, config, anon_key, service_role_key FROM projects
      WHERE ref = ${TARGET} AND deleted_at IS NULL
    `;
    assert.ok(project);
    guardTarget(hostname(), process.platform, process.env.SUPACLOUD_SUPAUTH_ACCEPTANCE, project);
    const httpProject = await (await management("")).json();
    assert.equal(httpProject.ref, project.ref);
    assert.equal(httpProject.name, project.name);
    const tenantConnection = databaseOptions(env.DATABASE_URL, project.db_name);
    tenant = new SQL(tenantConnection);
    const [tenantIdentity] = await tenant`SELECT current_database() AS name`;
    assert.equal(tenantIdentity.name, project.db_name);
    evidence.tenantDatabaseVerified = true;
    await tenant`SET statement_timeout = '15s'`;
    const ledger = await (await management("/database/migrations")).json();
    assert.ok(Array.isArray(ledger));
    checkLedger(artifact.migrations, ledger, mode === "live");
    if (mode === "provision") {
      stage = "fresh-schema-guard";
      const [schema] = await tenant`
        SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'supaoauth') AS present
      `;
      assert.equal(schema.present, false);
      assert.ok(!ledger.some(r => artifact.migrations.some(m => m.name === r.name || m.version === String(r.version))));
      for (const m of artifact.migrations) {
        stage = `migration-v${m.version}`;
        abort.signal.throwIfAborted();
        if (m.version === "10") {
          for (const table of ["webhooks", "webhook_deliveries"]) {
            const [presence] = await tenant`SELECT to_regclass(${"supaoauth." + table}) IS NOT NULL AS present`;
            if (presence.present) {
              const counts: Array<{ n: number }> = await tenant.unsafe(`SELECT count(*)::int AS n FROM supaoauth.${table}`);
              assert.equal(counts[0]?.n, 0, "Legacy webhook data prevents migration");
            }
          }
          evidence.legacyWebhookTablesEmptyOrAbsent = true;
        }
        // Keep the source SQL intact; the API records and executes its canonical form.
        const receipt = await (await management("/database/migrations", "POST", {
          version: m.version, name: m.name, sql: m.sql,
        })).json();
        assert.equal(receipt.checksum, m.checksum);
        const readback = await (await management("/database/migrations")).json();
        checkLedger([m], readback, true);
        console.log(JSON.stringify({ migration: m.name, checksum: m.checksum, ledgerVerified: true }));
      }
      checkLedger(artifact.migrations, await (await management("/database/migrations")).json(), true);
      evidence.migrationsVerified = artifact.migrations.length;
    } else {
      stage = "emulator-preflight";
      const [policy] = await tenant`
        SELECT admin_auth_mode, admin_allowed_emails, admin_allowed_domains FROM supaoauth.security_config
      `;
      assert.ok(policy && ["auto", "sso"].includes(policy.admin_auth_mode));
      assert.deepEqual(policy.admin_allowed_emails, []);
      assert.deepEqual(policy.admin_allowed_domains, []);
      assert.ok(env.SUPAOAUTH_BFF_SIGNING_SECRET && env.SUPAOAUTH_BFF_SIGNING_SECRET.length >= 32
        && env.SUPAOAUTH_BFF_SIGNING_SECRET !== env.MASTER_TOKEN);
      assert.ok(project.anon_key && project.service_role_key);
      assert.ok(Number.isInteger(project.config?.gotrue_port) && project.config.gotrue_port > 0);
      const transport: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const r = new Request(input, init);
        assert.equal(new URL(r.url).origin, gateway);
        return fetch(r, { signal: AbortSignal.timeout(15_000) });
      }) as typeof fetch;
      const options = {
        global: { fetch: transport },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      };
      admin = createClient(gateway, project.service_role_key, options);
      const client = createClient(gateway, project.anon_key, options);
      stage = "gotrue-sso-user";
      const password = `${randomBytes(32).toString("hex")}Aa1!`;
      userAttempted = true;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      userId = created.data.user?.id;
      assert.ok(!created.error && userId, "GoTrue test user creation failed");
      const login = await client.auth.signInWithPassword({ email, password });
      assert.ok(!login.error && login.data.user?.id === userId, "GoTrue password login failed");
      passwordSession = login.data.session?.access_token;
      assert.ok(passwordSession, "GoTrue password session missing");
      stage = "sso-client-registration";
      adminOAuthClientAttempted = true;
      const adminClientResponse = await management("/auth/oauth-clients", "POST", {
        client_name: adminOAuthClientName,
        client_type: "public",
        token_endpoint_auth_method: "none",
        redirect_uris: [callback],
        grant_types: ["authorization_code", "refresh_token"],
      });
      const adminClient = await adminClientResponse.json() as { client_id?: string };
      assert.ok(typeof adminClient.client_id === "string");
      adminOAuthClientId = adminClient.client_id;
      stage = "management-collaborator-provisioning";
      collaboratorAttempted = true;
      const collaboratorResponse = await management("/collaborators", "POST", {
        principal_id: userId,
        email,
        role: "admin",
      });
      const collaborator = await collaboratorResponse.json() as { id?: string };
      assert.ok(typeof collaborator.id === "string");
      collaboratorId = collaborator.id;
      const collaborators = await (await management("/collaborators")).json();
      assert.ok(collaborators.items.some((r: Record<string, unknown>) =>
        r.id === collaboratorId && r.principal_id === userId && r.role === "admin" && r.status === "active"));
      evidence.ssoCollaboratorProvisioned = true;
      stage = "gotrue-sso-pkce";
      session = await acquireSsoToken({ client, clientId: adminOAuthClientId, subject: userId!, email, transport });
      evidence.ssoPkceAndSignatureVerified = true;
      const probe = Bun.listen({ hostname: "127.0.0.1", port: 4010, socket: { data() {} } });
      probe.stop(true);
      child = Bun.spawn([process.execPath, "--no-env-file", emulator], {
        cwd: directory, stdout: "ignore", stderr: "ignore", stdin: "ignore",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "development",
          HOST: "127.0.0.1", PORT: "4010", RUNTIME_MODE: "gotrue", LOG_LEVEL: "error",
          SUPACLOUD_API_URL: "http://127.0.0.1:9090", SUPACLOUD_MASTER_TOKEN: env.MASTER_TOKEN,
          SUPABASE_SERVICE_ROLE_KEY: project.service_role_key,
          SUPAOAUTH_BFF_SIGNING_SECRET: env.SUPAOAUTH_BFF_SIGNING_SECRET,
          PROJECT_REF: TARGET, SUPACLOUD_AUTH_AUTHORITY_REF: TARGET,
          OAUTH_RUNTIME_URL: gateway, OAUTH_RUNTIME_INTERNAL_URL: `http://127.0.0.1:${project.config.gotrue_port}`,
          SUPAUTH_PUBLIC_URL: facade, SUPACLOUD_DATABASE_URL: tenantConnection.url,
          ...ssoEnvironment(email, adminOAuthClientId),
          NODE_EXTRA_CA_CERTS: "/var/lib/supacloud/caddy/pki/authorities/local/root.crt",
          NO_PROXY: "*",
        },
      });
      stage = "emulator-readiness";
      let ready = false;
      for (let i = 0; i < 60; i++) {
        abort.signal.throwIfAborted();
        assert.equal(child.exitCode, null, "Emulator exited before readiness");
        try {
          const response = await fetch(`${facade}/v1/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok) {
            const health = await response.json();
            assert.equal(health.project_ref, TARGET);
            assert.equal(health.runtime_mode, "gotrue");
            ready = true;
            break;
          }
        } catch { /* The owned listener may not be ready yet. */ }
        await Bun.sleep(200);
      }
      assert.ok(ready, "Emulator readiness timed out");
      stage = "gotrue-sso-session";
      const identity = await (await request(facade, "/v1/auth/identity", session!)).json();
      assert.equal(identity.id, userId);
      assert.equal(identity.email, email);
      assert.equal(identity.authorization_source, "admin_allowlist");
      evidence.gotrueSsoAdminSession = true;
      stage = "supauth-delegated-organizations-read";
      await request(facade, "/v1/organizations", session!);
      evidence.delegatedAdminRead = true;
      Object.assign(process.env, {
        MASTER_TOKEN: env.MASTER_TOKEN, SUPACLOUD_SUPAUTH_RBAC_TEST: "1",
        SUPACLOUD_TEST_SUPAUTH_URL: facade, SUPACLOUD_TEST_SUPAUTH_BEARER: session!,
      });
      stage = "gotrue-pkce-supauth-rbac";
      Object.assign(evidence, await verifyGatewayOAuthPkce({
        ref: TARGET, url: gateway, subject: userId!, client, transport,
      }));
    }
  } catch (error) {
    failed = true;
    evidence.failure = safeFailure(error, stage);
  } finally {
    // Cleanup is independent of an aborted acceptance signal.
    cleaning = true;
    try {
      await cleanupAll([
        async () => {
          if (!admin || !passwordSession) return;
          const signedOut = await admin.auth.admin.signOut(passwordSession, "global");
          assert.ok(!signedOut.error, "GoTrue session cleanup failed");
        },
        async () => {
          if (collaboratorAttempted) {
            if (!collaboratorId) {
              const rows = await (await management("/collaborators")).json() as { items?: Array<{ id?: string; principal_id?: string }> };
              const matches = (rows.items ?? []).filter(row => row.principal_id === userId);
              assert.ok(matches.length <= 1);
              collaboratorId = matches[0]?.id;
            }
            if (collaboratorId) {
              const removed = await management(`/collaborators/${collaboratorId}`, "DELETE");
              assert.ok(removed.ok);
              const readback = await (await management("/collaborators")).json();
              assert.ok(!readback.items.some((r: Record<string, unknown>) =>
                r.id === collaboratorId || r.principal_id === userId));
            }
          }
        },
        async () => {
          if (!adminOAuthClientAttempted) return;
          if (!adminOAuthClientId) {
            const rows = await (await management("/auth/oauth-clients")).json();
            adminOAuthClientId = ownedOAuthClient(rows, adminOAuthClientName);
          }
          if (adminOAuthClientId) {
            const removed = await management(`/auth/oauth-clients/${adminOAuthClientId}`, "DELETE");
            assert.ok(removed.ok || removed.status === 404);
            const readback = await fetch(`http://127.0.0.1:9090/v1/projects/${TARGET}/auth/oauth-clients/${adminOAuthClientId}`, {
              headers: { authorization: `Bearer ${env.MASTER_TOKEN}` }, signal: AbortSignal.timeout(15_000),
            });
            assert.equal(readback.status, 404);
          }
        },
        async () => {
          if (!userAttempted || !admin || !tenant) return;
          if (!userId) {
            const rows = await tenant`SELECT id FROM auth.users WHERE email = ${email}`;
            assert.ok(rows.length <= 1);
            userId = rows[0]?.id;
          }
          if (userId) {
            const removed = await admin.auth.admin.deleteUser(userId);
            assert.ok(!removed.error, "Test user cleanup failed");
            const rows = await tenant`SELECT id FROM auth.users WHERE id = ${userId}`;
            assert.equal(rows.length, 0);
            const sessions = await tenant`SELECT id FROM auth.sessions WHERE user_id = ${userId}`;
            assert.equal(sessions.length, 0);
            evidence.gotrueUserAndSessionCleanup = true;
          }
        },
        async () => {
          if (!child) return;
          if (child.exitCode === null) child.kill("SIGTERM");
          for (let i = 0; i < 50 && child.exitCode === null; i++) await Bun.sleep(100);
          if (child.exitCode === null) child.kill("SIGKILL");
          await child.exited;
          const probe = Bun.listen({ hostname: "127.0.0.1", port: 4010, socket: { data() {} } });
          probe.stop(true);
        },
        async () => { await tenant?.close(); },
        async () => { await metadata?.close(); },
        async () => { await rmdir(lock); },
      ]);
      evidence.cleanup = true;
    } catch {
      failed = true;
      evidence.cleanup = false;
    }
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
  }
  console.log(JSON.stringify({ status: failed ? "PARTIAL" : "PASS", ...evidence }));
  if (failed) process.exitCode = 1;
}

if (import.meta.main) {
  await runSupAuthAcceptance(Bun.argv[2]!, Bun.argv[3]!, Bun.argv[4]!).catch(() => {
    console.log(JSON.stringify({ status: "PARTIAL", failure: { stage: "launcher-preflight" } }));
    process.exitCode = 1;
  });
}
