import { expect, test } from "bun:test";
import { SQL } from "bun";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { startStarterPostgres } from "../../../../scripts/lib/starter-postgres";
import { PGMQ_SQL } from "../../../supacloud-lite/src/runtime/db/emulated";
import { COMMAND_PERSISTENCE_SQL } from "../../../db/src/command-schema";
import { STARTER_REVIEW_SCHEMA } from "../../../cli/src/shared/tools/app-starter-postgres";
import { STARTER_ATTACHMENT_SCHEMA } from "../../../cli/src/shared/tools/app-starter-attachments";
import { STARTER_UPLOAD_SCHEMA } from "../../../cli/src/shared/tools/app-starter-upload";
import { STARTER_RUNTIME_ROLES_SCHEMA } from "../../../cli/src/shared/tools/app-starter-roles";
import { runtimeInput } from "../helpers/application-runtime";
import {
  createApplicationCompatibilityVerifier, executeApplicationCompatibility, type ApplicationCompatibilityInput,
} from "../../src/services/application-compatibility";
import {
  starterDatabaseOptions, verifyStarterCompatibility, type StarterCompatibilityPolicy,
} from "../../src/services/application-starter-compatibility";
import { stableSha256 } from "../../src/utils/stable-json";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
const entry = resolve(import.meta.dir, "../../src/scripts/verify-starter-compatibility.ts");
const request = (input: ApplicationCompatibilityInput) => ({
  schema: "supacloud.application-compatibility-request.v1", nonce: crypto.randomUUID(),
  input_sha256: stableSha256(input), input,
});

test("starter verifier rejects malformed envelopes before any I/O", async () => {
  for (const value of [null, {}, { schema: "supacloud.application-compatibility-request.v1", nonce: "old" }]) {
    await expect(verifyStarterCompatibility(value, {} as StarterCompatibilityPolicy))
      .rejects.toThrow("STARTER_COMPATIBILITY_NOT_VERIFIED:request");
  }
});

test.skipIf(!bin)("concrete command probes native schema/roles and TLS identity/RPC without mutating application data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-verifier-"));
  const postgres = await startStarterPostgres(bin!);
  let database: SQL | undefined, service: SQL | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const password = crypto.randomUUID(), serviceKey = crypto.randomUUID(), storageSubject = crypto.randomUUID();
  try {
    await postgres.exec("CREATE DATABASE supa_demo");
    const base = await postgres.withConnection(async url => {
      const connection = new URL(url);
      connection.pathname = "/supa_demo";
      return connection.href;
    });
    database = new SQL({ ...starterDatabaseOptions(base), max: 3 });
    const db = database;
    await db.unsafe(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE ROLE service_role LOGIN BYPASSRLS PASSWORD '${password}';
      CREATE ROLE starter_http_login LOGIN PASSWORD '${password}';
      CREATE ROLE starter_worker_login LOGIN PASSWORD '${password}';
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,version text,metadata jsonb,owner uuid);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    `);
    await db.unsafe(PGMQ_SQL);
    for (const name of ["workflows-public", "commands-public", "artifacts-public"]) {
      await db.unsafe(await readFile(resolve(import.meta.dir, `../../src/db/sql-modules/${name}.sql`), "utf8"));
    }
    for (const sql of [COMMAND_PERSISTENCE_SQL, STARTER_REVIEW_SCHEMA, STARTER_ATTACHMENT_SCHEMA,
      STARTER_UPLOAD_SCHEMA, STARTER_RUNTIME_ROLES_SCHEMA]) await db.unsafe(sql);
    await db.unsafe(`
      GRANT starter_review_http TO starter_http_login;
      GRANT starter_review_worker TO starter_worker_login;
      GRANT SELECT ON public.starter_application TO service_role;
      INSERT INTO public.starter_application(project_id,tenant_id) VALUES ('demo','owned-tenant');
      INSERT INTO public.starter_members(subject,can_approve,storage_subject) VALUES ('owner',true,'${storageSubject}');
    `);
    const connection = (username: string) => {
      const url = new URL(base);
      url.username = username; url.password = password;
      return url.href;
    };
    service = new SQL({ ...starterDatabaseOptions(connection("service_role")), max: 2 });
    const serviceDb = service;
    const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { stdout: "ignore", stderr: "ignore" });
    expect(await openssl.exited).toBe(0);
    const ca = await readFile(join(directory, "cert.pem"), "utf8");
    const keys = await generateKeyPair("ES256"), jwk = await exportJWK(keys.publicKey);
    let wrongSdkBinding = false, rejectServiceKey = false, rejectIdentity = false, wrongJwks = false;
    let calls = 0, rpcCalls = 0;
    // Local TLS HTTP adapter executes real read-only SQL; not a claim of live GoTrue/PostgREST acceptance.
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      tls: { cert: ca, key: await readFile(join(directory, "key.pem"), "utf8") },
      async fetch(req) {
        calls++;
        const url = new URL(req.url);
        if (url.pathname === "/jwks") return Response.json({ keys: wrongJwks ? [] : [jwk] });
        if (url.pathname === "/auth/v1/user") {
          if (rejectIdentity) return new Response(null, { status: 401 });
          try {
            const token = req.headers.get("authorization")?.slice(7) ?? "";
            await jwtVerify(token, keys.publicKey, { issuer: `${server!.url.origin}/auth/v1`, audience: "authenticated" });
            return Response.json({ id: storageSubject });
          } catch { return new Response(null, { status: 401 }); }
        }
        if (rejectServiceKey || req.headers.get("apikey") !== serviceKey
          || req.headers.get("authorization") !== `Bearer ${serviceKey}`) return new Response(null, { status: 401 });
        try {
          if (url.pathname === "/rest/v1/starter_application" && req.method === "GET") {
            const rows = await serviceDb.begin("READ ONLY", tx =>
              tx.unsafe("SELECT project_id,tenant_id FROM public.starter_application WHERE singleton"));
            return Response.json(wrongSdkBinding ? [{ project_id: "other", tenant_id: "owned-tenant" }] : rows);
          }
          if (url.pathname === "/rest/v1/rpc/supacloud_workflow_get" && req.method === "POST") {
            rpcCalls++;
            const body = await req.json();
            expect(Object.keys(body)).toEqual(["request"]);
            const rows = await serviceDb.begin("READ ONLY", tx =>
              tx.unsafe("SELECT public.supacloud_workflow_get($1::jsonb) AS result", [body.request]));
            return Response.json(rows[0].result);
          }
          return new Response(null, { status: 404 });
        } catch { return new Response(null, { status: 500 }); }
      },
    });
    const origin = server.url.origin;
    const token = (claims = { client_id: "starter-client", role: "authenticated" }, expires = "5m") =>
      new SignJWT(claims).setProtectedHeader({ alg: "ES256" }).setSubject("owner")
        .setIssuer(`${origin}/auth/v1`).setAudience("authenticated").setIssuedAt().setExpirationTime(expires).sign(keys.privateKey);
    const runtime = runtimeInput();
    const common = { SUPACLOUD_PROJECT_ID: "demo", APP_TENANT_ID: "owned-tenant", SUPACLOUD_URL: origin,
      SUPACLOUD_SERVICE_ROLE_KEY: serviceKey };
    const input: ApplicationCompatibilityInput = {
      runtime, previous: null,
      environment: {
        api: { ...common, DATABASE_URL: connection("starter_http_login"), REVIEW_ATTACHMENTS: "enabled",
          SUPAUTH_ISSUER: `${origin}/auth/v1`, SUPAUTH_JWKS_URL: `${origin}/jwks`,
          SUPAUTH_AUDIENCE: "authenticated", SUPAUTH_CLIENT_ID: "starter-client" },
        jobs: { ...common, DATABASE_URL: connection("starter_worker_login"), REVIEW_WORKER_ID: "owned-worker",
          REVIEW_QUEUE_OWNERSHIP: "exclusive-review-attachments" },
      },
      migrations: {
        schema: "supacloud.application-migrations.v1", project_ref: "demo", application_id: "reviews",
        release_id: runtime.release.release_id, manifest_sha256: runtime.release.manifest_sha256,
        ledger_digest: "d".repeat(64), ledger_compatible: true, project_migrations_applied: true,
        declaration_conflicts: [], targets: [], operator_provisioning: "separate-verification-required",
        compatibility: "not-proven", execution_performed: false, data_recovery: "separate-required",
      },
    };
    const policy: StarterCompatibilityPolicy = {
      schema: "supacloud.starter-compatibility-policy.v1", project_ref: "demo", application_id: "reviews",
      environment_id: "test", environment_sha256: stableSha256(input.environment),
      releases: [{ manifest_sha256: runtime.release.manifest_sha256, revision: 1 }],
      database: "supa_demo", http_role: "starter_http_login", worker_role: "starter_worker_login",
      inspection: { url: base }, identity_token: await token(), ca, bun_executable: process.execPath,
    };
    const policyFile = join(directory, "starter-policy.json");
    const run = async (candidate = input, configuration = policy, raw?: string) => {
      await writeFile(policyFile, JSON.stringify(configuration), { mode: 0o600 });
      const envelope = request(candidate);
      const child = Bun.spawn([process.execPath, "--no-env-file", entry, "--policy", policyFile], {
        cwd: "/", env: {
          PATH: "/usr/bin:/bin", DATABASE_URL: await postgres.withConnection(async url => url),
          PGDATABASE: "postgres", DATABASE_NAME: "postgres", PGUSER: "wrong_management",
          DATABASE_USER: "wrong_management", PGPASSWORD: "wrong", PGPORT: "1", PGHOST: "127.0.0.2",
        }, stdin: new TextEncoder().encode(raw ?? JSON.stringify(envelope)),
        stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(stdout + stderr).not.toContain(password);
        expect(stdout + stderr).not.toContain(serviceKey);
        expect(stdout + stderr).not.toContain(configuration.identity_token);
        return { code, stdout, stderr, envelope };
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    };
    const pass = async () => {
      const result = await run();
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schema: "supacloud.application-compatibility-result.v1", nonce: result.envelope.nonce,
        input_sha256: result.envelope.input_sha256, compatible: true,
        checks: { schema: true, bindings: true, runtime: true, operator_provisioning: true },
      });
    };
    const fail = async (phase: string, candidate = input, configuration = policy) => {
      const result = await run(candidate, configuration);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(`STARTER_COMPATIBILITY_NOT_VERIFIED:${phase}`);
    };
    const snapshot = async () => JSON.stringify(await db.unsafe(`SELECT
      (SELECT count(*) FROM pgmq.q_supacloud_internal_workflows) AS queue,
      (SELECT count(*) FROM supacloud_workflows.runs) AS runs,
      (SELECT count(*) FROM supacloud_workflows.events) AS events,
      (SELECT count(*) FROM supacloud_commands.execution_receipts) AS receipts,
      (SELECT count(*) FROM public.starter_attachment_results) AS results,
      (SELECT count(*) FROM storage.objects) AS objects`));
    const before = await snapshot();
    await pass();
    await pass();
    expect(rpcCalls).toBe(4);
    expect(await snapshot()).toBe(before);
    // Build only this verifier entry, never the compiler or application archive.
    const binary = join(directory, "verify");
    const build = Bun.spawn([process.execPath, "build", entry, "--compile", "--outfile", binary], {
      stdout: "ignore", stderr: "pipe",
    });
    const buildErrors = new Response(build.stderr).text();
    expect(await build.exited).toBe(0);
    expect(await buildErrors).not.toContain("error:");
    // Installed mode must not authorize another Bun binary in place of systemd's path.
    await expect(executeApplicationCompatibility(binary, JSON.stringify(request(input))))
      .rejects.toThrow("APPLICATION_COMPATIBILITY_REJECTED");
    const diagnostic = join(directory, "diagnostic");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(diagnostic, `#!/bin/sh\nexec ${quote(binary)} --policy ${quote(policyFile)}\n`, { mode: 0o700 });
    await expect(createApplicationCompatibilityVerifier({
      executable: async () => diagnostic, execute: executeApplicationCompatibility,
    })(input)).resolves.toBeUndefined();
    expect(await snapshot()).toBe(before);

    const callsBefore = calls;
    await fail("policy", input, { ...policy, project_ref: "foreign" });
    await fail("policy", input, { ...policy, releases: [] });
    await fail("policy", input, { ...policy, environment_sha256: "0".repeat(64) });
    await fail("policy", { ...input, migrations: { ...input.migrations, project_ref: "foreign" } });
    expect(calls).toBe(callsBefore);
    await fail("identity", input, { ...policy, identity_token: await token({ client_id: "foreign", role: "authenticated" }) });
    await fail("identity", input, { ...policy, identity_token: await token(undefined, "-1m") });
    wrongJwks = true; await fail("identity"); wrongJwks = false;
    rejectIdentity = true; await fail("identity"); rejectIdentity = false;

    await db.unsafe("UPDATE public.starter_application SET tenant_id='foreign'");
    await fail("schema-bindings");
    await db.unsafe("UPDATE public.starter_application SET tenant_id='owned-tenant'");
    await db.unsafe("UPDATE public.starter_members SET enabled=false");
    await fail("schema-bindings");
    await db.unsafe("UPDATE public.starter_members SET enabled=true");
    await db.unsafe("ALTER ROLE starter_review_worker BYPASSRLS");
    await fail("schema-bindings");
    await db.unsafe("ALTER ROLE starter_review_worker NOBYPASSRLS");
    await db.unsafe("ALTER TABLE public.starter_reviews RENAME COLUMN version TO missing_version");
    await fail("schema-bindings");
    await db.unsafe("ALTER TABLE public.starter_reviews RENAME COLUMN missing_version TO version");
    await db.unsafe("GRANT starter_review_http TO starter_worker_login");
    await fail("schema-bindings");
    await db.unsafe("REVOKE starter_review_http FROM starter_worker_login");
    await db.unsafe("REVOKE INSERT ON public.starter_attachment_results FROM starter_review_worker");
    await fail("schema-bindings");
    await db.unsafe("GRANT INSERT ON public.starter_attachment_results TO starter_review_worker");
    await db.unsafe("ALTER TABLE public.starter_reviews DISABLE ROW LEVEL SECURITY");
    await fail("operator-provisioning");
    await db.unsafe("ALTER TABLE public.starter_reviews ENABLE ROW LEVEL SECURITY");
    await db.unsafe("UPDATE storage.buckets SET public=true");
    await fail("operator-provisioning");
    await db.unsafe("UPDATE storage.buckets SET public=false");
    await db.unsafe("ALTER FUNCTION public.supacloud_workflow_get(jsonb) OWNER TO starter_http_login");
    await fail("operator-provisioning");
    await db.unsafe("ALTER FUNCTION public.supacloud_workflow_get(jsonb) OWNER TO starter_test");
    await db.unsafe("SELECT pgmq.send('supacloud_internal_workflows','{}'::jsonb,0)");
    await fail("operator-provisioning");
    expect(Number((await db.unsafe("SELECT count(*) AS n FROM pgmq.q_supacloud_internal_workflows"))[0].n)).toBe(1);
    await db.unsafe("DELETE FROM pgmq.q_supacloud_internal_workflows");
    await db.unsafe("ALTER TABLE pgmq.q_supacloud_internal_workflows RENAME TO missing_queue");
    await fail("operator-provisioning");
    await db.unsafe("ALTER TABLE pgmq.missing_queue RENAME TO q_supacloud_internal_workflows");
    wrongSdkBinding = true; await fail("operator-provisioning"); wrongSdkBinding = false;
    rejectServiceKey = true; await fail("operator-provisioning"); rejectServiceKey = false;
    await fail("runtime", input, { ...policy, bun_executable: "/missing/bun" });
    await fail("runtime", { ...input, runtime: { ...input.runtime, bunVersion: "0.0.1" } });
    await fail("schema-bindings", input, {
      ...policy, releases: [{ manifest_sha256: runtime.release.manifest_sha256, revision: 2 }],
    });
    await db.unsafe(`ALTER TABLE public.starter_application ADD COLUMN delivery_revision integer NOT NULL DEFAULT 2;
      ALTER TABLE public.starter_attachment_results ADD COLUMN writer_revision text NOT NULL DEFAULT 'v1'`);
    policy.releases[0]!.revision = 2;
    await pass();
    expect(await snapshot()).toBe(before);
    await chmod(policyFile, 0o644);
    const untrusted = await run();
    expect(untrusted.code).toBe(1);
    expect(untrusted.stderr.trim()).toBe("STARTER_COMPATIBILITY_NOT_VERIFIED:request");
  } finally {
    server?.stop(true);
    await service?.close({ timeout: 1 });
    await database?.close({ timeout: 1 });
    await postgres.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
