import assert from "node:assert/strict";
import { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { verifyGatewayOAuthPkce } from "./platform-oauth-pkce";
import { verifyGatewayRealtime } from "./platform-realtime-websocket";
import { config } from "../../src/config";

// This fixture creates temporary users and a bucket in an explicitly selected test tenant.
assert.equal(process.env.SUPACLOUD_GATEWAY_TEST, "1");
const ref = process.env.SUPACLOUD_TEST_PROJECT_REF;
assert.ok(ref && /^[a-z0-9]{10,32}$/.test(ref));
assert.ok(process.env.DATABASE_URL);
const database = new SQL(process.env.DATABASE_URL);
let projectDatabase: SQL | undefined;
const eventTable = `realtime_acceptance_${crypto.randomUUID().replaceAll("-", "")}`;
let eventTableCreated = false;
const evidence: Record<string, boolean> = {};
try {
  const [project] = await database`
    SELECT name, anon_key, service_role_key, db_name FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
  `;
  assert.ok(project?.name.startsWith("platform-app-acceptance-"));
  assert.ok(project.anon_key && project.service_role_key);
  if (process.env.SUPACLOUD_REALTIME_CDC_TEST === "1") {
    assert.equal(process.env.SUPACLOUD_REALTIME_TEST, "1");
    assert.equal(project.db_name, `supa_${ref}`);
    projectDatabase = new SQL({
      hostname: config.pgHost, port: config.pgPort, username: config.pgUser,
      password: config.pgPassword, database: project.db_name, max: 1,
    });
    const [identity] = await projectDatabase`SELECT current_database() AS name`;
    assert.equal(identity?.name, project.db_name, "CDC fixture connected to the wrong database");
    await projectDatabase`SET statement_timeout = '15s'`;
    eventTableCreated = true;
    await projectDatabase.unsafe(`CREATE TABLE public.${eventTable} (
      id uuid PRIMARY KEY, marker text NOT NULL
    )`);
    await projectDatabase.unsafe(`
      ALTER TABLE public.${eventTable} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.${eventTable} REPLICA IDENTITY FULL;
      GRANT SELECT ON public.${eventTable} TO authenticated;
      CREATE POLICY realtime_acceptance_read ON public.${eventTable}
        FOR SELECT TO authenticated USING (true);
      ALTER PUBLICATION supabase_realtime ADD TABLE public.${eventTable};
    `);
  }
  const hostname = `${ref}.api.localhost`;
  const url = `https://${hostname}`;
  // Only the dedicated loopback test gateway uses a self-signed certificate.
  const transport: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    assert.equal(target.origin, url);
    target.hostname = "127.0.0.1";
    const headers = new Headers(request.headers);
    headers.set("host", hostname);
    return fetch(target, {
      method: request.method, headers, redirect: request.redirect,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      tls: { rejectUnauthorized: false },
      proxy: undefined,
      signal: AbortSignal.timeout(15_000),
    });
  }) as typeof fetch;
  const options = {
    global: { fetch: transport },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  };
  const oidc = process.env.SUPACLOUD_OIDC_TEST === "1";
  let verifyOidc: ((token: string, subject: string) => Promise<void>) | undefined;
  if (oidc) {
    // Migration is a separate explicit operation, never retried on an unknown
    // or partial outcome. Read-only OIDC probes can run against configured keys.
    if (process.env.SUPACLOUD_OIDC_MIGRATE === "1") {
      assert.ok(process.env.MASTER_TOKEN);
      const migrated = await fetch(`http://127.0.0.1:9090/v1/projects/${ref}/auth/oauth-server/migrate`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.MASTER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ allow_dynamic_registration: false }),
        signal: AbortSignal.timeout(120_000),
      });
      assert.equal(migrated.status, 200, "OIDC migration did not confirm runtime apply");
    }
    const issuer = `${url}/auth/v1`;
    const discoveryResponse = await transport(`${issuer}/.well-known/openid-configuration`);
    assert.equal(discoveryResponse.status, 200, "discovery unavailable through gateway");
    const discovery = await discoveryResponse.json();
    assert.equal(discovery.issuer, issuer);
    assert.equal(discovery.jwks_uri, `${issuer}/.well-known/jwks.json`);
    assert.equal(discovery.authorization_endpoint, `${issuer}/oauth/authorize`);
    assert.equal(discovery.token_endpoint, `${issuer}/oauth/token`);
    assert.equal(discovery.userinfo_endpoint, `${issuer}/oauth/userinfo`);
    const keyResponse = await transport(discovery.jwks_uri);
    assert.equal(keyResponse.status, 200, "JWKS unavailable through gateway");
    const jwks = await keyResponse.json();
    assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0, "public signing keys missing");
    for (const key of jwks.keys) {
      assert.ok(["EC", "RSA"].includes(key.kty), "JWKS must contain public asymmetric keys");
      for (const privateField of ["d", "p", "q", "dp", "dq", "qi", "k"]) {
        assert.equal(privateField in key, false, "JWKS contains private key material");
      }
    }
    const keys = createLocalJWKSet(jwks);
    verifyOidc = async (token, subject) => {
      const verified = await jwtVerify(token, keys, {
        issuer, audience: "authenticated", algorithms: ["ES256", "RS256"],
        requiredClaims: ["sub", "exp", "iat", "session_id"],
      });
      assert.equal(verified.payload.sub, subject);
      assert.equal(verified.payload.role, "authenticated");
    };
    evidence.gatewayOidcDiscovery = true;
  }
  const admin = createClient(url, project.service_role_key, options);
  const client = createClient(url, project.anon_key, options);
  const other = createClient(url, project.anon_key, options);
  const anonymous = createClient(url, project.anon_key, options);
  const suffix = crypto.randomUUID();
  const bucket = `gateway-${suffix}`;
  const email = `gateway-${suffix}@example.com`;
  const password = `${crypto.randomUUID()}Aa1!`;
  const otherEmail = `gateway-other-${suffix}@example.com`;
  const otherPassword = `${crypto.randomUUID()}Aa1!`;
  let userId: string | undefined;
  let otherUserId: string | undefined;
  let bucketAttempted = false;
  let otherSignupAttempted = false;
  const check = (error: { status?: number; code?: string } | null, stage: string) => {
    assert.equal(error, null, `${stage} failed (status=${error?.status}, code=${error?.code})`);
  };
  try {
    const signup = await client.auth.signUp({ email, password });
    userId = signup.data.user?.id;
    check(signup.error, "signup");
    assert.ok(userId);
    const login = await client.auth.signInWithPassword({ email, password });
    check(login.error, "password login");
    assert.equal(login.data.user?.id, userId);
    if (verifyOidc) {
      assert.ok(login.data.session?.access_token);
      await verifyOidc(login.data.session.access_token, userId);
      const claims = await client.auth.getClaims();
      check(claims.error, "official SDK claims verification");
      assert.equal(claims.data?.claims.sub, userId);
      evidence.gatewayOidcSignedSession = true;
    }
    const user = await client.auth.getUser();
    check(user.error, "user readback");
    assert.equal(user.data.user?.id, userId);
    const refresh = await client.auth.refreshSession();
    check(refresh.error, "session refresh");
    assert.equal(refresh.data.user?.id, userId);
    if (verifyOidc) {
      assert.ok(refresh.data.session?.access_token);
      await verifyOidc(refresh.data.session.access_token, userId);
      evidence.gatewayOidcSignedRefresh = true;
    }
    evidence.gatewayAuth = true;
    if (process.env.SUPACLOUD_REALTIME_TEST === "1") {
      assert.ok(oidc && refresh.data.session?.access_token, "Realtime acceptance requires an OIDC session");
      Object.assign(evidence, await verifyGatewayRealtime({
        hostname, anonKey: project.anon_key, accessToken: refresh.data.session.access_token,
        cdc: projectDatabase ? { table: eventTable, insert: async (marker, signal) => {
          // The subscription acknowledgment can precede the poller's slot
          // creation after an empty publication gains its first table.
          const deadline = Date.now() + 90_000;
          while (true) {
            signal.throwIfAborted();
            const slots = await projectDatabase!`
              SELECT slot_name FROM pg_replication_slots
              WHERE database = current_database() AND plugin = 'wal2json'
                AND starts_with(slot_name, ${`supabase_realtime_${ref}_`})
            `;
            if (slots.length > 0) break;
            assert.ok(Date.now() < deadline, "Tenant wal2json slot was not prepared");
            await Bun.sleep(100);
          }
          signal.throwIfAborted();
          const rows = await projectDatabase!.unsafe(
            `INSERT INTO public.${eventTable} (id, marker) VALUES ($1, $2) RETURNING marker`,
            [crypto.randomUUID(), marker],
          );
          assert.equal(rows[0]?.marker, marker);
        } } : undefined,
      }));
      if (projectDatabase) {
        const slots = await projectDatabase`
          SELECT slot_name, plugin FROM pg_replication_slots
          WHERE database = current_database()
            AND slot_type = 'logical'
            AND plugin = 'wal2json'
            AND starts_with(slot_name, ${`supabase_realtime_${ref}_`})
        `;
        assert.ok(slots.length > 0, "No tenant wal2json replication slot");
        evidence.gatewayRealtimeTenantSlot = true;
      }
    }
    const inventory = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    check(inventory.error, "SDK admin user list");
    assert.ok(inventory.data.users.some((user) => user.id === userId));
    evidence.gatewayAuthAdminList = true;
    if (process.env.SUPACLOUD_OAUTH_PKCE_TEST === "1") {
      assert.ok(oidc, "OAuth acceptance requires configured OIDC verification");
      Object.assign(evidence, await verifyGatewayOAuthPkce({ ref, url, subject: userId, client, transport }));
    }

    bucketAttempted = true;
    const create = await admin.storage.createBucket(bucket, { public: false });
    check(create.error, "create bucket");
    const contents = `gateway-roundtrip:${suffix}`;
    const upload = await admin.storage.from(bucket).upload("proof.txt", contents, {
      contentType: "text/plain",
    });
    check(upload.error, "upload");
    const download = await admin.storage.from(bucket).download("proof.txt");
    check(download.error, "download");
    assert.equal(await download.data!.text(), contents);
    evidence.gatewayStorageRoundtrip = true;

    const denied = await client.storage.from(bucket).download("proof.txt");
    assert.ok(denied.error, "unprivileged user unexpectedly read the private object");
    assert.ok([400, 401, 403, 404].includes(Number(denied.error.statusCode)),
      "a transport or server failure does not prove access denial");
    evidence.privateObjectDenied = true;

    otherSignupAttempted = true;
    const otherSignup = await other.auth.signUp({ email: otherEmail, password: otherPassword });
    otherUserId = otherSignup.data.user?.id;
    check(otherSignup.error, "second signup");
    assert.ok(otherUserId && otherUserId !== userId);
    const otherLogin = await other.auth.signInWithPassword({ email: otherEmail, password: otherPassword });
    check(otherLogin.error, "second password login");
    assert.equal(otherLogin.data.user?.id, otherUserId);

    const ownerContents = `owner:${suffix}`;
    const otherContents = `other:${suffix}`;
    check((await client.storage.from(bucket).upload("owner.txt", ownerContents)).error, "owner upload");
    check((await other.storage.from(bucket).upload("other.txt", otherContents)).error, "second owner upload");
    const expectContents = async (actor: typeof client, name: string, expected: string) => {
      const result = await actor.storage.from(bucket).download(name);
      check(result.error, "owned download");
      assert.equal(await result.data!.text(), expected);
    };
    const expectDenied = (error: { statusCode?: string | number } | null) => {
      assert.ok(error, "cross-user request unexpectedly succeeded");
      assert.ok([400, 401, 403, 404].includes(Number(error.statusCode)),
        "a transport or server failure does not prove access denial");
    };
    await expectContents(client, "owner.txt", ownerContents);
    await expectContents(other, "other.txt", otherContents);
    expectDenied((await other.storage.from(bucket).download("owner.txt")).error);
    expectDenied((await client.storage.from(bucket).download("other.txt")).error);
    expectDenied((await anonymous.storage.from(bucket).download("owner.txt")).error);
    expectDenied((await anonymous.storage.from(bucket).upload("anonymous.txt", "denied")).error);
    expectDenied((await other.storage.from(bucket).update("owner.txt", "tampered")).error);
    expectDenied((await other.storage.from(bucket).upload("owner.txt", "tampered", { upsert: true })).error);
    // RLS-filtered deletion may return success with no rows; verify the actual object survives.
    const foreignDelete = await other.storage.from(bucket).remove(["owner.txt"]);
    if (foreignDelete.error) expectDenied(foreignDelete.error);
    else assert.deepEqual(foreignDelete.data, []);
    await expectContents(client, "owner.txt", ownerContents);
    evidence.storageOwnerIsolation = true;

    for (const [actor, names] of [
      [client, ["owner.txt"]], [other, ["other.txt"]], [anonymous, []],
    ] as const) {
      const visible = await actor.schema("storage").from("objects")
        .select("name").eq("bucket_id", bucket).order("name");
      check(visible.error, "PostgREST storage metadata");
      assert.deepEqual(visible.data?.map((row) => row.name), names);
    }
    evidence.postgrestOwnerRls = true;
    const refreshed = await client.auth.refreshSession();
    check(refreshed.error, "owner refresh");
    assert.equal(refreshed.data.user?.id, userId);
    await expectContents(client, "owner.txt", ownerContents);
    expectDenied((await client.storage.from(bucket).download("other.txt")).error);
    evidence.refreshedSessionRls = true;
    check((await client.storage.from(bucket).update("owner.txt", `${ownerContents}:updated`)).error, "owner update");
    await expectContents(client, "owner.txt", `${ownerContents}:updated`);
    check((await client.storage.from(bucket).remove(["owner.txt"])).error, "owner delete");
    const remaining = await admin.schema("storage").from("objects")
      .select("name").eq("bucket_id", bucket).eq("name", "owner.txt");
    check(remaining.error, "deleted metadata readback");
    assert.deepEqual(remaining.data, []);
    evidence.ownerMutation = true;
    const signout = await client.auth.signOut();
    check(signout.error, "sign out");
    check((await other.auth.signOut()).error, "second sign out");
  } finally {
    const failures: string[] = [];
    const attempt = async (
      label: string,
      operation: () => Promise<{ error: { status?: number; statusCode?: number | string } | null }>,
    ) => {
      try {
        const result = await operation();
        const status = result.error?.statusCode ?? result.error?.status;
        if (result.error && Number(status) !== 404) failures.push(label);
      } catch {
        failures.push(label);
      }
    };
    // Retry cleanup even when the preceding response was lost after the server committed.
    if (bucketAttempted) try {
      const listed = await admin.storage.from(bucket).list("", { limit: 1000 });
      const listStatus = listed.error?.statusCode ?? listed.error?.status;
      if (listed.error && Number(listStatus) !== 404) failures.push("object-list");
      else if (!listed.error && listed.data.length > 0) {
        await attempt("object", () => admin.storage.from(bucket).remove(
          listed.data.map((entry) => entry.name),
        ));
      }
    } catch {
      failures.push("object-list");
    }
    if (bucketAttempted) await attempt("bucket", () => admin.storage.deleteBucket(bucket));

    for (const [knownId, address] of [[userId, email], [otherUserId, otherEmail]]) {
      if (address === otherEmail && !otherSignupAttempted) continue;
      let cleanupUserId = knownId;
      if (!cleanupUserId) {
        try {
          for (let page = 1; ; page++) {
            const users = await admin.auth.admin.listUsers({ page, perPage: 1000 });
            check(users.error, "cleanup user lookup");
            cleanupUserId = users.data.users.find((candidate) => candidate.email === address)?.id;
            if (cleanupUserId || users.data.users.length < 1000) break;
          }
        } catch {
          failures.push("list-user");
        }
      }
      if (cleanupUserId) {
        await attempt("user", () => admin.auth.admin.deleteUser(cleanupUserId));
      }
    }
    assert.deepEqual(failures, [], `Cleanup failed: ${failures.join(",")}`);
    evidence.cleanup = true;
  }
} finally {
  try {
    if (eventTableCreated) {
      await projectDatabase!.unsafe(`DROP TABLE IF EXISTS public.${eventTable}`);
      const [remaining] = await projectDatabase!`SELECT to_regclass(${`public.${eventTable}`}) AS relation`;
      assert.equal(remaining?.relation, null, "CDC fixture table cleanup failed");
    }
  } finally {
    try { await projectDatabase?.close(); }
    finally { await database.close(); }
  }
}
console.log(JSON.stringify(evidence));
