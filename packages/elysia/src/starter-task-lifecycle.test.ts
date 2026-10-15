import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { compileProject, compileOptionsFromConfig, loadSupacloudConfig } from "@supacloud/compiler";
import { databaseSources } from "../../db/src/source-contracts";
import type { CommandDatabase, CommandTransaction } from "../../db/src/command-adapter";
import { COMMAND_PERSISTENCE_SQL } from "../../db/src/command-schema";
import { appStarterFiles } from "../../cli/src/shared/tools/app-starter";
import { PGMQ_SQL } from "../../supacloud-lite/src/runtime/db/emulated";
import { startStarterPostgres, type StarterPostgres } from "../../../scripts/lib/starter-postgres";
import { SupaCloudWorkflowsClient } from "../../supacloud-js/dist/index.mjs";
import type { ApplicationOptions, CompiledModule, SupAuthContextOptions } from "./index";

type SqlValue = string | number | boolean | null;
interface Retry { reviewId: string; expectedVersion: number; expectedRunId: string; recoveryId: string }
interface TaskPort {
  attachmentTask(context: unknown, id: string): Promise<unknown>;
  retryAttachmentTask(context: unknown, input: Retry): Promise<unknown>;
}
interface TaskHost {
  createReviewTaskAdapters(options: { database: CommandDatabase; projectId: string; tenantId: string }): Promise<TaskPort>;
}
interface AttachmentOptions { database: CommandDatabase; projectId: string; tenantId: string; service: SupabaseClient }
interface AttachmentHost {
  createReviewAttachmentAdapters(options: AttachmentOptions): Promise<{
    enqueue(tx: CommandTransaction, id: string, version: number): Promise<void>;
    store: {
      readResult(input: { reviewId: string; version: number; artifactId: string }): Promise<unknown>;
      recordAttachment(input: { reviewId: string; version: number; artifactId: string }, result: unknown): Promise<unknown>;
    };
  }>;
}
interface UploadHost { createReviewUploadAdapters(options: AttachmentOptions): Promise<unknown> }
interface PostgresHost {
  createReviewPostgresAdapters(options: {
    database: CommandDatabase; tenantId: string; identity: Omit<SupAuthContextOptions, "resolveAccess">;
    tasks: TaskPort; uploads: unknown; afterApproved(tx: CommandTransaction, id: string, version: number): Promise<void>;
  }): Promise<Pick<ApplicationOptions, "deps" | "commandGovernance"> & {
    requestContext(request: Request): Promise<unknown>;
  }>;
}
interface WorkerHost {
  createReviewAttachmentWorker(options: AttachmentOptions & {
    modules: readonly CompiledModule[];
    workflows: Pick<SupaCloudWorkflowsClient, "claim" | "complete" | "retry" | "fail">; workerId: string;
    queueOwnership: "exclusive-review-attachments"; pollIntervalMs: number;
  }): Promise<{ start(): Promise<void>; close(): Promise<void>; failure: Promise<never> }>;
}
interface GeneratedClient {
  createApiClient(options: { baseUrl: string; fetch: typeof fetch }): {
    reviewTasks: {
      status(input: { params: { id: string } }): Promise<unknown>;
      retry(input: { params: { id: string }; body: Omit<Retry, "reviewId"> }): Promise<unknown>;
    };
  };
}
const bin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];
if (!bin && process.env["SUPACLOUD_REQUIRE_RUNTIME_SAFETY"] === "1") throw new Error("PostgreSQL binaries are required");
const native = bin ? describe : describe.skip;
const files = appStarterFiles("task-lifecycle-test");
const content = new TextEncoder().encode("verified evidence");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected record");
  return value as Record<string, unknown>;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected rows");
  return value.map(record);
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

native("generated review task lifecycle", () => {
  let createApplication: typeof import("./index").createApplication;
  let root: string;
  let database: StarterPostgres;
  let modules: CompiledModule[];
  let tasks: TaskHost, attachments: AttachmentHost, uploads: UploadHost, postgres: PostgresHost, workerHost: WorkerHost;
  let identity: Omit<SupAuthContextOptions, "resolveAccess">;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let service: SupabaseClient;
  let workflows: SupaCloudWorkflowsClient;
  const artifacts = new Map<string, Record<string, unknown>>();
  const transport = { offline: false, downloads: 0 };
  const fault = { loseCommit: false };
  async function sql(query: string, parameters: readonly SqlValue[] = []) {
    return rows(await database.transaction(tx => tx.query(query, parameters)));
  }
  function scoped(role: "starter_review_http" | "starter_review_worker"): CommandDatabase {
    return { async transaction(run) {
      let recoveryWrite = false;
      const result = await database.transaction(async tx => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        return run({ query(query, parameters) {
          if (query.startsWith("INSERT INTO public.starter_attachment_retries")) recoveryWrite = true;
          return tx.query(query, parameters);
        } });
      });
      if (recoveryWrite && fault.loseCommit) {
        fault.loseCommit = false;
        throw new Error("Private connection string: lost commit acknowledgement");
      }
      return result;
    } };
  }
  beforeAll(async () => {
    // Source typechecks run before this package is built. Native acceptance still
    // loads the same built adapter as the generated host, preserving class identity.
    const runtime: typeof import("./index") = await import(new URL("../dist/index.js", import.meta.url).href);
    createApplication = runtime.createApplication;
    root = await mkdtemp(join(import.meta.dir, ".task-lifecycle-"));
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const dependencies = resolve(import.meta.dir, "../node_modules");
    await mkdir(join(root, "node_modules/@supacloud"), { recursive: true });
    for (const name of await readdir(dependencies)) {
      if (name === "@supacloud") continue;
      await symlink(join(dependencies, name), join(root, "node_modules", name));
    }
    for (const name of await readdir(join(dependencies, "@supacloud"))) {
      await symlink(join(dependencies, "@supacloud", name), join(root, "node_modules/@supacloud", name));
    }
    await symlink(resolve(import.meta.dir, ".."), join(root, "node_modules/@supacloud/elysia"));
    await symlink(resolve(import.meta.dir, "../../supacloud-js"), join(root, "node_modules/@supacloud/js"));
    for (const name of ["drizzle-orm", "drizzle-kit"]) {
      await rm(join(root, "node_modules", name), { recursive: true, force: true });
      await symlink(resolve(import.meta.dir, "../../db/node_modules", name), join(root, "node_modules", name));
    }
    const sources = await databaseSources(root, "generate");
    if (!sources.ok) throw new Error(JSON.stringify(sources.findings));
    const options = compileOptionsFromConfig(await loadSupacloudConfig(root), root);
    const compiled = await compileProject(options);
    const errors = compiled.diagnostics.filter(item => item.severity === "error");
    if (errors.length) throw new Error(JSON.stringify(errors, null, 2));
    const generated: { createCompiledModules(): CompiledModule[] } = await import(join(root, "generated/application.ts"));
    modules = generated.createCompiledModules();
    tasks = await import(join(root, "src/host/review-tasks.ts"));
    attachments = await import(join(root, "src/host/review-attachments.ts"));
    uploads = await import(join(root, "src/host/review-uploads.ts"));
    postgres = await import(join(root, "src/host/review-postgres.ts"));
    workerHost = await import(join(root, "src/host/review-attachment-worker.ts"));
    database = await startStarterPostgres(bin!);
    await database.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await database.exec(PGMQ_SQL);
    for (const name of ["workflows-public", "commands-public"]) {
      await database.exec(await readFile(new URL(`../../management-api/src/db/sql-modules/${name}.sql`, import.meta.url), "utf8"));
    }
    await database.exec(COMMAND_PERSISTENCE_SQL);
    await database.exec(`CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
      CREATE TABLE storage.objects(bucket_id text,name text);
    `);
    for (const name of Object.keys(files).filter(path => path.startsWith("migrations/")).sort()) {
      if (name === "migrations/005-review-task-recovery.sql") {
        await database.exec("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated");
      }
      await database.exec(files[name]!);
    }
    await database.exec("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated");
    await database.exec("INSERT INTO public.starter_application(project_id,tenant_id) VALUES('project','tenant')");
    await database.exec(files["tests/database-governance.sql"]!);
    const keys = await generateKeyPair("ES256");
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    identity = {
      issuer: "https://identity.test.invalid", audience: "review-test", clientId: "review-test", projectId: "project",
      jwksUrl: "https://identity.test.invalid/jwks", keyResolver: createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] }),
    };
    const rpc: Record<string, string> = {
      supacloud_workflow_claim: "SELECT public.supacloud_workflow_claim($1::text::jsonb) AS value",
      supacloud_workflow_complete: "SELECT public.supacloud_workflow_complete($1::text::jsonb) AS value",
      supacloud_workflow_retry: "SELECT public.supacloud_workflow_retry($1::text::jsonb) AS value",
      supacloud_workflow_fail: "SELECT public.supacloud_workflow_fail($1::text::jsonb) AS value",
      supacloud_workflow_get: "SELECT public.supacloud_workflow_get($1::text::jsonb) AS value",
    };
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/storage/")) {
        transport.downloads++;
        return transport.offline ? new Response("offline", { status: 503 })
          : new Response(content, { headers: { "content-type": "text/plain" } });
      }
      const name = url.pathname.split("/").at(-1)!;
      const request = record(record(JSON.parse(text(init?.body)))["request"]);
      const statement = rpc[name];
      if (statement) {
        const result = await database.transaction(async tx => {
          await tx.query("SET LOCAL ROLE service_role");
          return rows(await tx.query(statement, [JSON.stringify(request)]))[0]?.["value"];
        });
        return Response.json(result ?? null);
      }
      const artifactId = text(request["artifactId"]);
      if (name === "supacloud_artifact_register") {
        const previous = artifacts.get(artifactId);
        const value = { ...request, objectVersion: "", createdAt: "2026-10-16T00:00:00Z", parents: [] };
        if (!previous) artifacts.set(artifactId, value);
        return Response.json({ ...(previous ?? value), idempotent: Boolean(previous) });
      }
      if (name === "supacloud_artifact_get") {
        const value = artifacts.get(artifactId);
        return Response.json(value ? { ...value, idempotent: false } : null);
      }
      throw new Error("Unexpected fixture request");
    };
    service = createClient("https://platform.test.invalid", "server-only-fixture", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: Object.assign(fetcher, { preconnect: fetch.preconnect }) },
    });
    workflows = new SupaCloudWorkflowsClient(service);
  }, 60_000);
  afterAll(async () => {
    try { await database?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  }, 30_000);
  beforeEach(async () => {
    transport.offline = false;
    fault.loseCommit = false;
    await database.exec(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT id FROM supacloud_workflows.runs WHERE status IN ('queued','running') LOOP
        PERFORM supacloud_workflows.cancel_run(r.id,'Test isolation');
      END LOOP; END $$;`);
  });

  async function token(subject: string, expires = "5m", project = "review-test") {
    return new SignJWT({ client_id: project, role: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(identity.issuer).setAudience("review-test").setSubject(subject).setIssuedAt().setExpirationTime(expires).sign(privateKey);
  }
  async function fixture() {
    const id = crypto.randomUUID(), actor = crypto.randomUUID(), artifactId = crypto.randomUUID();
    await sql("INSERT INTO public.starter_members(subject,can_approve,storage_subject) VALUES($1::text,true,$1::text::uuid)", [actor]);
    await sql("INSERT INTO public.starter_reviews VALUES($1,$2,'draft',1)", [id, actor]);
    const http = scoped("starter_review_http");
    const taskPort = await tasks.createReviewTaskAdapters({ database: http, projectId: "project", tenantId: "tenant" });
    const attachmentOptions = { database: http, service, projectId: "project", tenantId: "tenant" };
    const durable = await attachments.createReviewAttachmentAdapters(attachmentOptions);
    const adapters = await postgres.createReviewPostgresAdapters({
      database: http, tenantId: "tenant", identity, tasks: taskPort,
      uploads: await uploads.createReviewUploadAdapters(attachmentOptions), afterApproved: durable.enqueue,
    });
    const app = createApplication({ modules, ...adapters });
    const jwt = await token(actor);
    const request = (path: string, body?: unknown, bearer = jwt) => new Request("https://app.test.invalid" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "idempotency-key": artifactId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const send = (suffix: string, body?: unknown, bearer = jwt) => app.handle(request(`/reviews/${id}/${suffix}`, body, bearer));
    const status = async () => {
      const response = await send("attachment-task");
      expect(response.status).toBe(200);
      return record(await response.json());
    };
    async function submit() {
      expect((await send("attachment-upload", { artifactId, expectedVersion: 1 })).status).toBe(200);
      const registration = await send("attachment-registration", { artifactId, expectedVersion: 1 });
      expect(registration.status).toBe(200);
      expect(record(await registration.json())["runId"]).toBe(artifactId);
      expect((await send("approve", { expectedVersion: 1 })).status).toBe(200);
    }
    async function failRun() {
      const claim = await workflows.claim({ workerId: "fixture-worker", visibilityTimeoutSeconds: 15 });
      if (!claim || claim.status !== "claimed") throw new Error("Missing claim");
      expect(claim.runId).toBe(artifactId);
      expect((await status())["state"]).toBe("running");
      await workflows.fail({ stepId: claim.stepId, messageId: claim.messageId, attempt: claim.attempt,
        workerId: claim.workerId, errorMessage: "private://worker/credentials must never reach the browser" });
      return claim;
    }
    const retry: Retry = { reviewId: id, expectedVersion: 2, expectedRunId: artifactId, recoveryId: crypto.randomUUID() };
    const retryBody = (input = retry) => ({ expectedVersion: input.expectedVersion,
      expectedRunId: input.expectedRunId, recoveryId: input.recoveryId });
    return { id, actor, artifactId, jwt, app, request, send, status, submit, failRun, retry, retryBody, adapters, taskPort };
  }
  async function driveWorker(runId: string, terminal: "completed" | "failed", timeout = 5000) {
    const worker = await workerHost.createReviewAttachmentWorker({
      database: scoped("starter_review_worker"), service, projectId: "project", tenantId: "tenant",
      modules, workflows, workerId: "worker-" + runId, queueOwnership: "exclusive-review-attachments", pollIntervalMs: 10,
    });
    try {
      await worker.start();
      await Promise.race([worker.failure, (async () => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if ((await workflows.get(runId))?.status === terminal) return;
          await Bun.sleep(20);
        }
        throw new Error("Worker did not reach " + terminal);
      })()]);
    } finally { await worker.close(); }
  }

  test("generated routes, client, OpenAPI and source contracts compile without manual artifact edits", async () => {
    const openapi: { OPENAPI_DOCUMENT: { paths: Record<string, unknown> } } = await import(join(root, "generated/openapi.ts"));
    expect(openapi.OPENAPI_DOCUMENT.paths["/reviews/{id}/attachment-task"]).toBeDefined();
    expect(openapi.OPENAPI_DOCUMENT.paths["/reviews/{id}/attachment-task/retry"]).toBeDefined();
    await writeFile(join(root, "consumer.ts"), `import { createApiClient } from "./generated/client";
import type { ReviewTaskStatus, ReviewRetryResult } from "./src/review/task-contracts";
const api = createApiClient();
const status: Promise<ReviewTaskStatus> = api.reviewTasks.status({ params: { id: "review" } });
const retry: Promise<ReviewRetryResult> = api.reviewTasks.retry({ params: { id: "review" },
  body: { expectedVersion: 2, expectedRunId: crypto.randomUUID(), recoveryId: crypto.randomUUID() } });
void status; void retry;
`);
    async function typecheck() {
      const child = Bun.spawn([join(import.meta.dir, "../node_modules/.bin/tsc"),
        "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--experimentalDecorators",
        "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler",
        "--noUncheckedIndexedAccess", "--exactOptionalPropertyTypes", "--noPropertyAccessFromIndexSignature",
        join(root, "consumer.ts"), join(root, "src/delivery-host.ts"), join(root, "src/delivery-worker.ts"),
      ], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output: out + err };
    }
    const valid = await typecheck();
    expect(valid.output).toBe("");
    expect(valid.code).toBe(0);
    const schema = files["db/schema.ts"]!;
    try {
      await writeFile(join(root, "db/schema.ts"), schema.replace("generation: integer().notNull()", "generation: text().notNull()"));
      const stale = await typecheck();
      expect(stale.code).not.toBe(0);
      expect(stale.output).toContain("review-tasks.ts");
      expect((await databaseSources(root, "check")).ok).toBe(false);
    } finally { await writeFile(join(root, "db/schema.ts"), schema); }
    expect((await databaseSources(root, "check")).ok).toBe(true);
  }, 30_000);

  test("authenticated customer flow submits, sees failure, retries and completes through the generated Worker", async () => {
    const f = await fixture();
    expect((await f.status())["state"]).toBe("not_submitted");
    await f.submit();
    expect((await f.status())["state"]).toBe("queued");
    await f.failRun();
    const failed = await f.status();
    expect(failed["state"]).toBe("failed");
    expect(failed["canRetry"]).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("private");
    expect(JSON.stringify(failed)).not.toContain("claimedBy");
    const generated: GeneratedClient = await import(join(root, "generated/client.ts"));
    const fetcher = (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("authorization", `Bearer ${f.jwt}`);
      return f.app.handle(request);
    };
    const client = generated.createApiClient({
      baseUrl: "https://app.test.invalid", fetch: Object.assign(fetcher, { preconnect: fetch.preconnect }),
    });
    const receipt = record(await client.reviewTasks.retry({ params: { id: f.id }, body: f.retryBody() }));
    expect(receipt["runId"]).toBe(f.retry.recoveryId);
    expect((await workflows.get(f.artifactId))?.status).toBe("failed");
    expect(record(await client.reviewTasks.status({ params: { id: f.id } }))["runId"]).toBe(f.retry.recoveryId);
    await driveWorker(f.retry.recoveryId, "completed");
    const completed = await f.status();
    expect(completed["state"]).toBe("completed");
    expect(completed["canRetry"]).toBe(false);
    expect(record(completed["result"])["artifactId"]).toBe(f.artifactId);
    expect((await f.send("attachment-task/retry", f.retryBody({ ...f.retry,
      expectedRunId: f.retry.recoveryId, recoveryId: crypto.randomUUID() }))).status).toBe(409);
  }, 30_000);

  test("missing, expired and cross-client credentials and foreign owners cannot inspect or retry", async () => {
    const f = await fixture();
    expect((await f.send("attachment-task", undefined, "")).status).toBe(401);
    expect((await f.send("attachment-task", undefined, await token(f.actor, "-1s"))).status).toBe(401);
    expect((await f.send("attachment-task", undefined, await token(f.actor, "5m", "wrong-client"))).status).toBe(401);
    const other = await fixture();
    expect((await f.send("attachment-task", undefined, other.jwt)).status).toBe(403);
    await f.submit(); await f.failRun();
    expect((await f.send("attachment-task/retry", f.retryBody(), other.jwt)).status).toBe(403);
    const context = await f.adapters.requestContext(f.request(`/reviews/${f.id}/attachment-task`));
    await sql("UPDATE public.starter_members SET can_approve=false WHERE subject=$1", [f.actor]);
    await expect(f.taskPort.attachmentTask(context, f.id)).rejects.toMatchObject({ code: "TASK_DENIED" });
    await expect(f.taskPort.retryAttachmentTask(context, f.retry)).rejects.toMatchObject({ code: "TASK_DENIED" });
    expect((await f.send("attachment-task")).status).toBe(403);
  });

  test("same recovery key replays once; concurrent distinct keys cannot fork one failed run", async () => {
    const f = await fixture();
    await f.submit(); await f.failRun();
    const responses = await Promise.all(Array.from({ length: 4 }, () => f.send("attachment-task/retry", f.retryBody())));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200]);
    expect(await sql("SELECT count(*)::integer AS count FROM public.starter_attachment_retries WHERE review_id=$1", [f.id]))
      .toEqual([{ count: 1 }]);
    expect(await sql("SELECT count(*)::integer AS count FROM supacloud_commands.execution_audit " +
      "WHERE command='review.retry-attachment' AND operation_key=$1", [f.retry.recoveryId])).toEqual([{ count: 1 }]);
    await sql("SELECT supacloud_workflows.cancel_run($1::uuid,'Test isolation')", [f.retry.recoveryId]);
    const g = await fixture();
    await g.submit(); await g.failRun();
    const concurrent = await Promise.all([g.retry, { ...g.retry, recoveryId: crypto.randomUUID() }]
      .map(input => g.send("attachment-task/retry", g.retryBody(input))));
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 409]);
  });

  test("active runs and changed input cannot be retried; stale receipts do not bypass current authorization", async () => {
    const f = await fixture();
    await f.submit();
    expect((await f.send("attachment-task/retry", f.retryBody())).status).toBe(409);
    await f.failRun();
    expect((await f.send("attachment-task/retry", f.retryBody())).status).toBe(200);
    expect((await f.send("attachment-task/retry", { ...f.retryBody(), expectedRunId: crypto.randomUUID() })).status).toBe(409);
    await sql("UPDATE public.starter_members SET enabled=false WHERE subject=$1", [f.actor]);
    expect((await f.send("attachment-task/retry", f.retryBody())).status).not.toBe(200);
  });

  test("lost commit acknowledgement is reconciled using the same recovery ID", async () => {
    const f = await fixture();
    await f.submit(); await f.failRun();
    fault.loseCommit = true;
    const response = await f.send("attachment-task/retry", f.retryBody());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("connection string");
    expect((await f.status())["runId"]).toBe(f.retry.recoveryId);
    expect((await f.send("attachment-task/retry", f.retryBody())).status).toBe(200);
    expect(await sql("SELECT count(*)::integer AS count FROM public.starter_attachment_retries WHERE review_id=$1", [f.id]))
      .toEqual([{ count: 1 }]);
  });

  test("audit failure rolls back new run, lineage, receipt and submission together", async () => {
    const f = await fixture();
    await f.submit(); await f.failRun();
    await database.exec(`CREATE FUNCTION public.reject_retry_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.command='review.retry-attachment' THEN RAISE EXCEPTION 'private audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_retry_audit BEFORE INSERT ON supacloud_commands.execution_audit
      FOR EACH ROW EXECUTE FUNCTION public.reject_retry_audit();`);
    try {
      expect((await f.send("attachment-task/retry", f.retryBody())).status).toBe(503);
    } finally { await database.exec("DROP TRIGGER reject_retry_audit ON supacloud_commands.execution_audit; DROP FUNCTION public.reject_retry_audit();"); }
    expect(await workflows.get(f.retry.recoveryId)).toBeNull();
    expect(await sql("SELECT count(*)::integer AS count FROM public.starter_attachment_retries WHERE review_id=$1", [f.id]))
      .toEqual([{ count: 0 }]);
    expect((await f.status())["runId"]).toBe(f.artifactId);
  });

  test("migration grants no browser access and the Worker cannot append recovery records", async () => {
    for (const role of ["anon", "authenticated", "starter_review_worker"]) {
      await expect(database.transaction(async tx => {
        await tx.query(`SET LOCAL ROLE ${role}`);
        return tx.query("INSERT INTO public.starter_attachment_retries VALUES($1,$2,$3,1)",
          [crypto.randomUUID(), "review", crypto.randomUUID()]);
      })).rejects.toThrow();
    }
    await expect(database.transaction(async tx => {
      await tx.query("SET LOCAL ROLE authenticated");
      return tx.query("SELECT supacloud_workflows.snapshot($1::uuid,false)", [crypto.randomUUID()]);
    })).rejects.toThrow();
    await expect(database.transaction(async tx => {
      await tx.query("SET LOCAL ROLE authenticated");
      return tx.query("SELECT * FROM public.starter_attachment_retries");
    })).rejects.toThrow();
  });

  test("automatic retries stop at the declared budget and leave an explicit recoverable failure", async () => {
    const f = await fixture();
    await f.submit();
    transport.offline = true;
    await driveWorker(f.artifactId, "failed", 20_000);
    const status = await f.status();
    expect(status["state"]).toBe("failed");
    expect(status["attempts"]).toBe(3);
    expect(status["canRetry"]).toBe(true);
    const run = await workflows.get(f.artifactId);
    expect(run?.steps[0]?.maxAttempts).toBe(3);
    expect(run?.steps[0]?.attempts).toBe(3);
    expect(await sql("SELECT count(*)::integer AS count FROM public.starter_attachment_retries WHERE review_id=$1", [f.id]))
      .toEqual([{ count: 0 }]);
  }, 30_000);

  test("explicit recovery reuses a committed verification result even when Storage is unavailable", async () => {
    const f = await fixture();
    await f.submit();
    const input = { reviewId: f.id, version: 2, artifactId: f.artifactId };
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)),
      byte => byte.toString(16).padStart(2, "0")).join("");
    const adapter = await attachments.createReviewAttachmentAdapters({
      database: scoped("starter_review_worker"), service, projectId: "project", tenantId: "tenant",
    });
    await adapter.store.recordAttachment(input, { ...input, sha256: digest, bytes: content.byteLength });
    await f.failRun();
    expect((await f.send("attachment-task/retry", f.retryBody())).status).toBe(200);
    const downloads = transport.downloads;
    transport.offline = true;
    await driveWorker(f.retry.recoveryId, "completed");
    expect(transport.downloads).toBe(downloads);
    expect((await f.status())["state"]).toBe("completed");
    expect(await sql("SELECT count(*)::integer AS count FROM public.starter_attachment_results WHERE review_id=$1", [f.id]))
      .toEqual([{ count: 1 }]);
  });

  test("cancelled tasks stay cancelled and invalid request contracts cannot create a recovery", async () => {
    const f = await fixture();
    await f.submit();
    await sql("SELECT supacloud_workflows.cancel_run($1::uuid,'Owner cancelled')", [f.artifactId]);
    expect((await f.status())["state"]).toBe("cancelled");
    expect((await f.status())["canRetry"]).toBe(false);
    expect((await f.send("attachment-task/retry", f.retryBody())).status).toBe(409);
    for (const body of [{ ...f.retryBody(), expectedVersion: 0 }, { ...f.retryBody(), recoveryId: "invalid" }]) {
      const response = await f.send("attachment-task/retry", body);
      expect([400, 422]).toContain(response.status);
    }
  });

  test("corrupt Workflow bindings and results fail closed without returning internal payloads", async () => {
    const f = await fixture();
    await f.submit(); await f.failRun();
    await sql("UPDATE supacloud_workflows.runs SET workflow_name='other.private.job' WHERE id=$1", [f.artifactId]);
    let response = await f.send("attachment-task");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("other.private");
    expect((await f.send("attachment-task/retry", f.retryBody())).status).toBe(503);
    await sql("UPDATE supacloud_workflows.runs SET workflow_name='review.verify-attachment',status='completed',output=$2::text::jsonb WHERE id=$1",
      [f.artifactId, JSON.stringify({ private: "bad output" })]);
    response = await f.send("attachment-task");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("bad output");
    expect(await workflows.get(f.retry.recoveryId)).toBeNull();
  });

  test("the Worker halts without settling a superseded execution", async () => {
    const f = await fixture();
    await f.submit();
    const stale = await f.failRun();
    expect((await f.send("attachment-task/retry", f.retryBody())).status).toBe(200);
    let settlements = 0;
    const worker = await workerHost.createReviewAttachmentWorker({
      database: scoped("starter_review_worker"), service, projectId: "project", tenantId: "tenant",
      modules, workerId: stale.workerId, queueOwnership: "exclusive-review-attachments", pollIntervalMs: 10,
      workflows: {
        claim: async () => stale,
        complete: request => { settlements++; return workflows.complete(request); },
        retry: request => { settlements++; return workflows.retry(request); },
        fail: request => { settlements++; return workflows.fail(request); },
      },
    });
    try {
      await worker.start();
      await expect(worker.failure).rejects.toThrow("requires recovery");
    } finally { await worker.close(); }
    expect(settlements).toBe(0);
    expect((await workflows.get(f.retry.recoveryId))?.status).toBe("queued");
  });
});