import { SQL } from "bun";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { applicationRuntimePlan } from "./application-runtime";
import type { ApplicationCompatibilityInput } from "./application-compatibility";
import { PLATFORM_PUBLIC_ROUTINE_VALUES_SQL } from "./platform-ownership";
import { stableSha256 } from "../utils/stable-json";
import { parsePostgresUrl } from "../utils/postgres-url";

/** Administrator policy, never read from an uploaded archive or activation request. */
export interface StarterCompatibilityPolicy {
  schema: "supacloud.starter-compatibility-policy.v1";
  project_ref: string;
  application_id: string;
  environment_id: string;
  environment_sha256: string;
  releases: { manifest_sha256: string; revision: 1 | 2 }[];
  database: string;
  http_role: string;
  worker_role: string;
  /** Optional project-scoped NOLOGIN groups from the administrator's provisioning policy. */
  runtime_groups?: { http: string; worker: string };
  inspection: { url: string } | { socket: string; username: string };
  identity_token: string;
  /** Optional private CA also installed in the application host's trust store. */
  ca?: string;
  /** Defaults to the exact runtime path used by applicationRuntimePlan. */
  bun_executable?: string;
}

function requireProbe(value: unknown): asserts value {
  if (!value) throw new Error("Probe failed");
}

async function json(url: string, policy: StarterCompatibilityPolicy, headers?: Record<string, string>, body?: unknown) {
  const endpoint = new URL(url);
  requireProbe(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.hash);
  const response = await fetch(endpoint, {
    method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
    ...(policy.ca ? { tls: { ca: policy.ca } } : {}),
  });
  requireProbe(response.ok);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      requireProbe(length <= 262144);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export function starterDatabaseOptions(url: string) {
  // Keep driver URL options (including TLS modes); explicit identity wins over
  // ambient management PG*/DATABASE_* settings in Bun's URL-only constructor.
  return { adapter: "postgres" as const, url, ...parsePostgresUrl(url) };
}

function connection(env: Readonly<Record<string, string>>): SQL.Options {
  requireProbe(!(env.DATABASE_SOCKET_PATH && env.DATABASE_URL));
  if (env.DATABASE_SOCKET_PATH) {
    requireProbe(env.DATABASE_NAME && env.DATABASE_USER);
    return { adapter: "postgres", path: env.DATABASE_SOCKET_PATH, database: env.DATABASE_NAME, username: env.DATABASE_USER };
  }
  requireProbe(env.DATABASE_URL);
  return starterDatabaseOptions(env.DATABASE_URL);
}

async function readOnly(options: SQL.Options, run: (tx: SQL) => Promise<void>) {
  const pool = new SQL({ ...options, max: 1, connectionTimeout: 3 });
  try {
    await pool.begin("READ ONLY", async tx => {
      await tx.unsafe("SET LOCAL statement_timeout = '3000ms'");
      await tx.unsafe("SET LOCAL lock_timeout = '1000ms'");
      await tx.unsafe("SET LOCAL search_path = pg_catalog");
      await run(tx);
    });
  } finally { await pool.close({ timeout: 1 }); }
}

async function runtimeProbe(path: string, version: string) {
  // Only this shipped program runs. Never import/execute privileged uploaded bundles.
  const script = `
    import { SQL } from "bun";
    import { AsyncLocalStorage } from "node:async_hooks";
    const context = new AsyncLocalStorage();
    const nonce = crypto.randomUUID();
    const server = Bun.serve({hostname:"127.0.0.1",port:0,
      fetch: () => Response.json({nonce})});
    try {
      const result = await context.run(nonce, async () => {
        await Promise.resolve();
        const response = await fetch(server.url);
        return (await response.json()).nonce === context.getStore();
      });
      if (!result || typeof SQL !== "function" || typeof Promise.withResolvers !== "function") process.exitCode=1;
      else console.log(Bun.version);
    } finally { server.stop(true); }
  `;
  const child = Bun.spawn([path, "--no-env-file", "-e", script], {
    cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    requireProbe(exit === 0 && output.trim() === version);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

async function runtimeDatabase(
  input: ApplicationCompatibilityInput, policy: StarterCompatibilityPolicy, target: "api" | "jobs", revision: 1 | 2,
  subject: string, storageSubject: string,
) {
  const env = input.environment[target]!;
  const role = target === "api" ? policy.http_role : policy.worker_role;
  const groups = policy.runtime_groups ?? { http: "starter_review_http", worker: "starter_review_worker" };
  requireProbe(groups.http !== groups.worker
    && [groups.http, groups.worker].every(name => /^[a-z_][a-z0-9_]{0,62}$/.test(name)));
  const group = target === "api" ? groups.http : groups.worker;
  await readOnly(connection(env), async tx => {
    const [identity] = await tx.unsafe(`SELECT current_database() AS database, current_user AS role,
      session_user AS login, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
      FROM pg_roles WHERE rolname=current_user`);
    requireProbe(identity?.database === policy.database && identity.role === role && identity.login === role);
    requireProbe(["rolsuper", "rolbypassrls", "rolcreaterole", "rolcreatedb", "rolreplication"]
      .every(name => identity[name] === false));
    // Reject extra/inherited role memberships, including SET ROLE escalation paths.
    const memberships = await tx.unsafe(`SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles
      WHERE oid <> current_user::regrole AND pg_has_role(current_user,oid,'MEMBER')`);
    requireProbe(memberships.length === 1 && memberships[0].rolname === group);
    requireProbe(["rolsuper", "rolbypassrls", "rolcreaterole", "rolcreatedb", "rolreplication"]
      .every(name => memberships[0][name] === false));
    const owned = await tx.unsafe(`SELECT oid FROM pg_class WHERE
      oid IN ('public.starter_application'::regclass,'public.starter_members'::regclass,
        'public.starter_reviews'::regclass,'public.starter_attachments'::regclass,
        'public.starter_attachment_results'::regclass)
      AND pg_has_role(current_user,relowner,'MEMBER')`);
    requireProbe(owned.length === 0);
    const [privileges] = await tx.unsafe(`SELECT
      has_schema_privilege(current_user,'public','CREATE') AS create_public,
      has_column_privilege(current_user,'public.starter_reviews','state','UPDATE') AS approve,
      has_table_privilege(current_user,'public.starter_attachment_results','INSERT') AS result_write,
      has_table_privilege(current_user,'public.starter_reviews','DELETE') AS delete_review`);
    requireProbe(!privileges.create_public && !privileges.delete_review
      && privileges.approve === (target === "api") && privileges.result_write === (target === "jobs"));
    const binding = await tx.unsafe("SELECT project_id,tenant_id FROM public.starter_application WHERE singleton");
    requireProbe(binding.length === 1 && binding[0].project_id === policy.project_ref
      && binding[0].tenant_id === env.APP_TENANT_ID);
    const members = await tx.unsafe(`SELECT storage_subject::text FROM public.starter_members
      WHERE subject=$1 AND enabled AND can_approve`, [subject]);
    requireProbe(members.length === 1 && members[0].storage_subject === storageSubject);
    await tx.unsafe(`SELECT a.object_path,a.run_id,r.state,r.version,m.can_approve
      FROM public.starter_attachments a JOIN public.starter_reviews r ON r.id=a.review_id AND r.owner_id=a.owner_id
      JOIN public.starter_members m ON m.subject=a.owner_id WHERE a.review_id=$1`, [crypto.randomUUID()]);
    if (revision === 2) {
      const rows = await tx.unsafe("SELECT delivery_revision FROM public.starter_application WHERE singleton");
      requireProbe(rows.length === 1 && rows[0].delivery_revision === 2);
    }
    if (target === "api") {
      await tx.unsafe(`SELECT tenant_id,actor_id,command,operation_key,kind,input_fingerprint,
        input_payload,dispatch_key,status,audit_state,result FROM supacloud_commands.execution_receipts LIMIT 0`);
      const [permissions] = await tx.unsafe(`SELECT
        has_table_privilege(current_user,'supacloud_commands.execution_receipts','INSERT') AS receipt,
        has_table_privilege(current_user,'supacloud_commands.execution_audit','INSERT') AS audit,
        has_table_privilege(current_user,'public.starter_attachments','INSERT') AS attachment,
        has_function_privilege(current_user,'supacloud_workflows.start_run(uuid,text,text,text,jsonb,integer)','EXECUTE') AS workflow,
        has_function_privilege(current_user,'supacloud_commands.snapshot(uuid,boolean)','EXECUTE') AS snapshot`);
      requireProbe(Object.values(permissions).every(value => value === true));
    } else {
      await tx.unsafe("SELECT review_id,version,artifact_id,result FROM public.starter_attachment_results LIMIT 0");
      // EXPLAIN without ANALYZE checks the real positional writer contract, never executes it.
      await tx.unsafe(revision === 1
        ? "EXPLAIN INSERT INTO public.starter_attachment_results VALUES ('probe',2,'00000000-0000-4000-8000-000000000000','{}') ON CONFLICT DO NOTHING"
        : "EXPLAIN INSERT INTO public.starter_attachment_results (review_id,version,artifact_id,result,writer_revision) VALUES ('probe',2,'00000000-0000-4000-8000-000000000000','{}','v2') ON CONFLICT DO NOTHING");
    }
  });
}

async function provisioning(input: ApplicationCompatibilityInput, policy: StarterCompatibilityPolicy) {
  const options: SQL.Options = "url" in policy.inspection
    ? starterDatabaseOptions(policy.inspection.url)
    : { adapter: "postgres", path: policy.inspection.socket, username: policy.inspection.username, database: policy.database };
  await readOnly(options, async tx => {
    const [identity] = await tx.unsafe("SELECT current_database() AS database");
    requireProbe(identity.database === policy.database);
    const [binding] = await tx.unsafe("SELECT project_id,tenant_id FROM public.starter_application WHERE singleton");
    requireProbe(binding?.project_id === policy.project_ref && binding.tenant_id === input.environment.api!.APP_TENANT_ID);
    const tables = await tx.unsafe(`SELECT relname,relrowsecurity FROM pg_class
      WHERE oid IN ('public.starter_application'::regclass,'public.starter_members'::regclass,
      'public.starter_reviews'::regclass,'public.starter_attachments'::regclass,
      'public.starter_attachment_results'::regclass,'storage.objects'::regclass)`);
    requireProbe(tables.length === 6 && tables.every((row: { relrowsecurity: boolean }) => row.relrowsecurity));
    const [bucket] = await tx.unsafe(`SELECT public,file_size_limit,allowed_mime_types
      FROM storage.buckets WHERE id='review-attachments'`);
    requireProbe(bucket?.public === false && Number(bucket.file_size_limit) === 1048576
      && JSON.stringify(bucket.allowed_mime_types) === '["text/plain"]');
    const fences = await tx.unsafe(`SELECT polname,polpermissive,pg_get_expr(polwithcheck,polrelid) AS check_expr
      FROM pg_policy WHERE (polrelid,polname) IN (
        ('public.starter_application'::regclass,'starter_backend_binding_immutable'),
        ('public.starter_members'::regclass,'starter_backend_member_immutable'),
        ('public.starter_attachments'::regclass,'starter_backend_attachment_immutable'),
        ('public.starter_reviews'::regclass,'starter_worker_review_immutable'))`);
    requireProbe(fences.length === 4 && fences.every((row: { polpermissive: boolean; check_expr: string }) =>
      !row.polpermissive && row.check_expr === "false"));
    const storageFences = await tx.unsafe(`SELECT polname,polpermissive FROM pg_policy
      WHERE polrelid='storage.objects'::regclass
        AND polname IN ('starter_attachment_owner_fence','starter_attachment_update_fence','starter_attachment_delete_fence')`);
    requireProbe(storageFences.length === 3 && storageFences.every((row: { polpermissive: boolean }) => !row.polpermissive));
    const wrappers = await tx.unsafe(`SELECT p.oid IS NOT NULL AND p.prosecdef
      AND p.proowner=n.nspowner AND has_function_privilege('service_role',p.oid,'EXECUTE') AS valid
      FROM (VALUES ${PLATFORM_PUBLIC_ROUTINE_VALUES_SQL}) AS expected(signature,private_schema)
      LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
      LEFT JOIN pg_namespace n ON n.nspname=expected.private_schema`);
    requireProbe(wrappers.length === 14 && wrappers.every((row: { valid: boolean }) => row.valid === true));
    const queues = await tx.unsafe("SELECT queue_name FROM pgmq.list_queues() WHERE queue_name='supacloud_internal_workflows'");
    requireProbe(queues.length === 1);
    // Inspect, never claim: the starter must not consume another application's work.
    const foreign = await tx.unsafe(`SELECT q.msg_id FROM pgmq.q_supacloud_internal_workflows q
      LEFT JOIN supacloud_workflows.steps s ON s.id::text=q.message->>'step_id' AND s.queue_message_id=q.msg_id
      LEFT JOIN supacloud_workflows.runs r ON r.id=s.run_id AND r.id::text=q.message->>'run_id'
      LEFT JOIN public.starter_attachments a ON a.run_id=r.id
      WHERE r.id IS NULL OR a.run_id IS NULL OR r.workflow_name <> 'review.verify-attachment'
        OR r.workflow_version <> '1' OR s.step_key <> 'verify' OR s.max_attempts <> 3
        OR r.input->>'reviewId' IS DISTINCT FROM a.review_id
        OR r.input->>'artifactId' IS DISTINCT FROM a.artifact_id::text LIMIT 1`);
    requireProbe(foreign.length === 0);
  });
}

/** Concrete, read-only preactivation probe for the shipped api/jobs review starter. */
export async function verifyStarterCompatibility(request: unknown, policy: StarterCompatibilityPolicy) {
  let phase = "request";
  try {
    requireProbe(request && typeof request === "object");
    const envelope = request as { schema: string; nonce: string; input_sha256: string; input: ApplicationCompatibilityInput };
    requireProbe(envelope.schema === "supacloud.application-compatibility-request.v1"
      && /^[a-f0-9-]{36}$/.test(envelope.nonce) && envelope.input_sha256 === stableSha256(envelope.input));
    const input = envelope.input, plan = applicationRuntimePlan(input.runtime);
    phase = "policy";
    requireProbe(policy.schema === "supacloud.starter-compatibility-policy.v1"
      && policy.project_ref === plan.projectRef && policy.application_id === plan.applicationId
      && policy.environment_id === plan.environmentId && policy.environment_sha256 === stableSha256(input.environment)
      && policy.database === `supa_${plan.projectRef}` && policy.http_role !== policy.worker_role);
    const approved = policy.releases.filter(release => release.manifest_sha256 === plan.manifestSha256);
    requireProbe(approved.length === 1 && [1, 2].includes(approved[0]!.revision));
    requireProbe(plan.targets.length === 2 && plan.targets.some(t => t.name === "api" && t.kind === "http")
      && plan.targets.some(t => t.name === "jobs" && t.kind === "worker")
      && Object.keys(input.environment).sort().join(",") === "api,jobs");
    const api = input.environment.api!, jobs = input.environment.jobs!;
    requireProbe(api.SUPACLOUD_PROJECT_ID === plan.projectRef && jobs.SUPACLOUD_PROJECT_ID === plan.projectRef
      && api.APP_TENANT_ID && api.APP_TENANT_ID === jobs.APP_TENANT_ID && api.REVIEW_ATTACHMENTS === "enabled"
      && jobs.REVIEW_QUEUE_OWNERSHIP === "exclusive-review-attachments" && jobs.REVIEW_WORKER_ID
      && api.SUPACLOUD_URL === jobs.SUPACLOUD_URL && api.SUPACLOUD_SERVICE_ROLE_KEY
      && jobs.SUPACLOUD_SERVICE_ROLE_KEY);
    requireProbe(input.migrations.ledger_compatible && input.migrations.project_migrations_applied
      && input.migrations.project_ref === plan.projectRef && input.migrations.application_id === plan.applicationId
      && input.migrations.release_id === plan.releaseId && input.migrations.manifest_sha256 === plan.manifestSha256
      && input.migrations.declaration_conflicts.length === 0);
    phase = "identity";
    const issuer = new URL(api.SUPAUTH_ISSUER!);
    requireProbe(issuer.protocol === "https:" && !issuer.username && !issuer.password && !issuer.hash
      && api.SUPAUTH_AUDIENCE && api.SUPAUTH_CLIENT_ID);
    const keys = await json(api.SUPAUTH_JWKS_URL!, policy) as JSONWebKeySet;
    const { payload } = await jwtVerify(policy.identity_token, createLocalJWKSet(keys), {
      issuer: api.SUPAUTH_ISSUER, audience: api.SUPAUTH_AUDIENCE, algorithms: ["ES256", "RS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    requireProbe(typeof payload.sub === "string" && payload.sub.trim() && payload.sub.length <= 1024
      && !/[\u0000-\u001f\u007f]/.test(payload.sub) && payload.role === "authenticated"
      && (payload.client_id ?? payload.azp) === api.SUPAUTH_CLIENT_ID
      && (payload.client_id === undefined || payload.client_id === api.SUPAUTH_CLIENT_ID)
      && (payload.azp === undefined || payload.azp === api.SUPAUTH_CLIENT_ID));
    const origin = new URL(api.SUPACLOUD_URL!);
    requireProbe(origin.protocol === "https:" && origin.pathname === "/" && !origin.search
      && !origin.username && !origin.password && !origin.hash);
    const user = await json(`${origin.origin}/auth/v1/user`, policy, {
      apikey: api.SUPACLOUD_SERVICE_ROLE_KEY, authorization: `Bearer ${policy.identity_token}`,
    });
    requireProbe(typeof user.id === "string" && /^[a-f0-9-]{36}$/.test(user.id));
    phase = "schema-bindings";
    for (const target of ["api", "jobs"] as const) {
      await runtimeDatabase(input, policy, target, approved[0]!.revision, payload.sub, user.id);
    }
    phase = "operator-provisioning";
    await provisioning(input, policy);
    // Read actual tenant rows through each service key; catches wrong-project SDK routing.
    for (const env of [api, jobs]) {
      const headers = { apikey: env.SUPACLOUD_SERVICE_ROLE_KEY!, authorization: `Bearer ${env.SUPACLOUD_SERVICE_ROLE_KEY}` };
      const binding = await json(`${origin.origin}/rest/v1/starter_application?select=project_id,tenant_id&singleton=eq.true`, policy, headers);
      requireProbe(Array.isArray(binding) && binding.length === 1 && binding[0].project_id === plan.projectRef
        && binding[0].tenant_id === api.APP_TENANT_ID);
      const absent = await json(`${origin.origin}/rest/v1/rpc/supacloud_workflow_get`, policy, headers,
        { request: { runId: crypto.randomUUID() } });
      requireProbe(absent === null);
    }
    phase = "runtime";
    await runtimeProbe(policy.bun_executable ?? `/opt/supacloud/bun/${plan.bunVersion}/bun`, plan.bunVersion);
    return {
      schema: "supacloud.application-compatibility-result.v1", nonce: envelope.nonce,
      input_sha256: envelope.input_sha256, compatible: true,
      checks: { schema: true, bindings: true, runtime: true, operator_provisioning: true },
    };
  } catch {
    throw new Error(`STARTER_COMPATIBILITY_NOT_VERIFIED:${phase}`);
  }
}
