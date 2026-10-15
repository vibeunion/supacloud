import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CommandDatabase, CommandTransaction } from "../../db/src/command-adapter";
import { COMMAND_PERSISTENCE_SQL } from "../../db/src/command-schema";
import { appStarterFiles } from "../../cli/src/shared/tools/app-starter";
import { PGMQ_SQL } from "../../supacloud-lite/src/runtime/db/emulated";
import { SupaCloudWorkflowsClient, type SupaCloudWorkflowClaim } from "../../supacloud-js/dist/index.mjs";
import { startStarterPostgres, type StarterPostgres } from "../../../scripts/lib/starter-postgres";

interface Input { reviewId: string; version: number; artifactId: string }
interface Result extends Input { sha256: string; bytes: number }
interface Store {
  readResult(input: Input): Promise<Result | null>;
  readAttachment(input: Input): Promise<{ body: Uint8Array; sha256: string }>;
  recordAttachment(input: Input, result: Result): Promise<Result>;
}
interface Adapters {
  store: Store;
  enqueue(tx: CommandTransaction, reviewId: string, version: number): Promise<void>;
}
interface Host {
  createReviewAttachmentAdapters(options: {
    database: CommandDatabase; service: SupabaseClient; projectId: string; tenantId: string;
  }): Promise<Adapters>;
}
interface Job { VerifyReviewAttachment: new (store: Store) => { run(input: Input): Promise<Result> } }

const bin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];
if (!bin && process.env["SUPACLOUD_REQUIRE_RUNTIME_SAFETY"] === "1") {
  throw new Error("SUPACLOUD_STARTER_POSTGRES_BIN is required");
}
const native = bin ? describe : describe.skip;
const body = new TextEncoder().encode("immutable approval evidence");
const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
  byte => byte.toString(16).padStart(2, "0")).join("");
const files = appStarterFiles("attachment-recovery-test");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected record");
  return value as Record<string, unknown>;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected rows");
  return value.map(record);
}

native("generated attachment recovery on PostgreSQL with Lite SQL queue compatibility", () => {
  let database: StarterPostgres;
  let root: string;
  let host: Host;
  let business: Job;
  beforeAll(async () => {
    root = await mkdtemp(join(import.meta.dir, ".attachment-recovery-"));
    for (const path of ["src/review/attachment.ts", "src/host/review-attachments.ts", "tests/attachment.test.ts"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), files[path]!);
    }
    await mkdir(join(root, "node_modules/@supacloud"), { recursive: true });
    await symlink(resolve(import.meta.dir, "../../supacloud-js"), join(root, "node_modules/@supacloud/js"));
    // The package under test supplies its own built runtime/declarations.
    await symlink(resolve(import.meta.dir, ".."), join(root, "node_modules/@supacloud/elysia"));
    host = await import(join(root, "src/host/review-attachments.ts"));
    business = await import(join(root, "src/review/attachment.ts"));
    database = await startStarterPostgres(bin!);
    await database.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await database.exec(PGMQ_SQL);
    for (const name of ["workflows-public", "commands-public"]) {
      await database.exec(await readFile(new URL(
        `../../management-api/src/db/sql-modules/${name}.sql`, import.meta.url), "utf8"));
    }
    await database.exec(COMMAND_PERSISTENCE_SQL);
    await database.exec(`
      CREATE SCHEMA auth;
      CREATE SCHEMA storage;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb
      $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT (auth.jwt()->>'sub')::uuid
      $$;
      CREATE TABLE storage.buckets (id text PRIMARY KEY,name text,public boolean,
        file_size_limit integer,allowed_mime_types text[]);
      CREATE TABLE storage.objects (bucket_id text,name text);
      ${files["migrations/001-review.sql"]}
      ${files["migrations/002-review-attachments.sql"]}
      ${files["migrations/003-review-uploads.sql"]}
      ${files["migrations/004-review-runtime-roles.sql"]}
      INSERT INTO public.starter_application(project_id,tenant_id) VALUES('project','tenant');
    `);
  }, 30_000);
  afterAll(async () => {
    try { await database?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  async function rows(text: string, params: readonly (string | number | boolean | null)[] = []) {
    return records(await database.transaction(tx => tx.query(text, params)));
  }
  async function fixture() {
    const input = { reviewId: crypto.randomUUID(), artifactId: crypto.randomUUID(), version: 2 };
    const owner = crypto.randomUUID(), runId = crypto.randomUUID();
    const objectPath = `${owner}/${input.reviewId}/${input.artifactId}.txt`;
    await rows("INSERT INTO public.starter_members(subject,can_approve) VALUES($1,true)", [owner]);
    await rows("INSERT INTO public.starter_reviews VALUES($1,$2,'approved',2)", [input.reviewId, owner]);
    await rows("INSERT INTO public.starter_attachments VALUES($1,$2,$3,$4,$5)",
      [input.reviewId, input.artifactId, owner, runId, objectPath]);
    const state = { requests: 0, writes: 0, unavailable: false, loseCommit: false };
    const fetcher = async (url: string | URL | Request) => {
      state.requests++;
      if (state.unavailable) return new Response("Storage unavailable", { status: 503 });
      if (String(url).endsWith("/rest/v1/rpc/supacloud_artifact_get")) {
        return Response.json({
          artifactId: input.artifactId, bucketId: "review-attachments", objectPath,
          objectVersion: "", artifactType: "review.attachment", sha256,
          sizeBytes: String(body.byteLength), mimeType: "text/plain", metadata: {},
          retentionUntil: null, createdBy: null, createdAt: "2026-10-15T00:00:00Z",
          idempotent: false, parents: [],
        });
      }
      expect(String(url)).toContain("/storage/v1/object/review-attachments/" + objectPath);
      return new Response(body, { headers: { "content-type": "text/plain" } });
    };
    const service = createClient("https://artifacts.test.invalid", "server-fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: Object.assign(fetcher, { preconnect: fetch.preconnect }) },
    });
    const scoped: CommandDatabase = {
      async transaction(run) {
        let inserted = false;
        const value = await database.transaction(async tx => {
          await tx.query("SET LOCAL ROLE starter_review_worker");
          return run({ async query(text, parameters) {
            if (text.startsWith("INSERT INTO public.starter_attachment_results")) {
              state.writes++;
              inserted = true;
            }
            return tx.query(text, parameters);
          } });
        });
        if (inserted && state.loseCommit) {
          state.loseCommit = false;
          throw new Error("Commit acknowledgement lost");
        }
        return value;
      },
    };
    const options = { database: scoped, service, projectId: "project", tenantId: "tenant" };
    const adapters = await host.createReviewAttachmentAdapters(options);
    const result = { ...input, sha256, bytes: body.byteLength };
    return { input, owner, runId, state, adapters, result, options,
      job: new business.VerifyReviewAttachment(adapters.store) };
  }
  async function persist(input: Input, value: unknown) {
    await rows("INSERT INTO public.starter_attachment_results VALUES($1,$2,$3,$4::text::jsonb) " +
      "ON CONFLICT(review_id,version,artifact_id) DO UPDATE SET result=excluded.result",
    [input.reviewId, input.version, input.artifactId, JSON.stringify(value)]);
  }
  async function snapshot(runId: string) {
    return (await rows("SELECT supacloud_workflows.snapshot($1::uuid,false) AS value", [runId]))[0]?.["value"];
  }
  async function claim(worker: string) {
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toEndWith("/rest/v1/rpc/supacloud_workflow_claim");
      expect(JSON.parse(String(init?.body))).toEqual({
        request: { workerId: worker, visibilityTimeoutSeconds: 15 },
      });
      return Response.json(
        (await rows("SELECT supacloud_workflows.claim_step($1,15) AS value", [worker]))[0]?.["value"],
      );
    };
    const service = createClient("https://workflows.test.invalid", "server-fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: Object.assign(fetcher, { preconnect: fetch.preconnect }) },
    });
    const claimed = await new SupaCloudWorkflowsClient(service).claim({
      workerId: worker, visibilityTimeoutSeconds: 15,
    });
    if (!claimed || claimed.status !== "claimed") throw new Error("Expected an owned Workflow claim");
    return claimed;
  }
  async function complete(claimed: SupaCloudWorkflowClaim, result: Result) {
    return record((await rows(
      "SELECT supacloud_workflows.complete_run($1::uuid,$2::bigint,$3::integer,$4,'{}'::jsonb,$5::text::jsonb) AS value",
      [claimed["stepId"], claimed["messageId"], claimed["attempt"], claimed["workerId"], JSON.stringify(result)],
    ))[0]?.["value"]);
  }

  test("generated Job and PostgreSQL adapter share a strictly typed output contract", async () => {
    const child = Bun.spawn([
      join(import.meta.dir, "../node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict",
      "--skipLibCheck", "--experimentalDecorators", "--target", "ES2022", "--module", "ESNext",
      "--moduleResolution", "bundler", "--noUncheckedIndexedAccess", "--exactOptionalPropertyTypes",
      "--noPropertyAccessFromIndexSignature", join(root, "src/host/review-attachments.ts"),
      join(root, "tests/attachment.test.ts"),
    ], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(out + err).toBe("");
    expect(code).toBe(0);
  });

  test("committed result survives redelivery and lost Workflow completion response", async () => {
    const f = await fixture();
    await database.transaction(async tx => {
      await tx.query("SET LOCAL ROLE starter_review_http");
      await f.adapters.enqueue(tx, f.input.reviewId, f.input.version);
    });
    expect(record(await snapshot(f.runId))["status"]).toBe("queued");
    const first = await claim("worker-first");
    expect(first["runId"]).toBe(f.runId);
    expect(await f.job.run(f.input)).toEqual(f.result);
    expect(f.state.requests).toBe(2);
    expect(record(await snapshot(f.runId))["status"]).toBe("running");
    // Simulate process loss before acknowledgement and expiry of the owned lease.
    await rows("SELECT pgmq.set_vt('supacloud_internal_workflows',$1::bigint,0)", [first["messageId"]]);
    const second = await claim("worker-restarted");
    expect(second["attempt"]).toBe(2);
    f.state.unavailable = true;
    const recreated = await host.createReviewAttachmentAdapters(f.options);
    const recovered = await new business.VerifyReviewAttachment(recreated.store).run(f.input);
    expect(recovered).toEqual(f.result);
    expect(f.state.requests).toBe(2);
    expect(f.state.writes).toBe(1);
    await expect((async () => {
      await complete(second, recovered);
      throw new Error("Completion response lost");
    })()).rejects.toThrow("Completion response lost");
    expect(record(await snapshot(f.runId))["status"]).toBe("completed");
    expect((await complete(second, recovered))["idempotent"]).toBe(true);
    await expect(complete(first, recovered)).rejects.toThrow();
    expect(await rows("SELECT count(*)::integer AS count FROM supacloud_workflows.events " +
      "WHERE run_id=$1 AND event_type='run_completed'", [f.runId])).toEqual([{ count: 1 }]);
  });

  test("lost database commit response recovers without Storage or another write", async () => {
    const f = await fixture();
    f.state.loseCommit = true;
    await expect(f.job.run(f.input)).rejects.toThrow("Commit acknowledgement lost");
    f.state.unavailable = true;
    expect(await f.job.run(f.input)).toEqual(f.result);
    expect(f.state.requests).toBe(2);
    expect(f.state.writes).toBe(1);
  });

  test("revoked access, changed ownership, revision and project binding block stored-result replay", async () => {
    const f = await fixture();
    await persist(f.input, f.result);
    for (const column of ["enabled", "can_approve"]) {
      await rows(`UPDATE public.starter_members SET ${column}=false WHERE subject=$1`, [f.owner]);
      await expect(f.job.run(f.input)).rejects.toThrow("authorization");
      await rows(`UPDATE public.starter_members SET ${column}=true WHERE subject=$1`, [f.owner]);
    }
    await rows("UPDATE public.starter_reviews SET owner_id='someone-else' WHERE id=$1", [f.input.reviewId]);
    await expect(f.job.run(f.input)).rejects.toThrow("authorization");
    await rows("UPDATE public.starter_reviews SET owner_id=$2 WHERE id=$1", [f.input.reviewId, f.owner]);
    await expect(f.job.run({ ...f.input, version: 3 })).rejects.toThrow("authorization");
    await expect(f.job.run({ ...f.input, artifactId: crypto.randomUUID() })).rejects.toThrow("authorization");
    await expect(host.createReviewAttachmentAdapters({ ...f.options, tenantId: "other" })).rejects.toThrow("binding");
    try {
      await rows("UPDATE public.starter_application SET project_id='changed'");
      await expect(f.job.run(f.input)).rejects.toThrow("authorization");
    } finally { await rows("UPDATE public.starter_application SET project_id='project'"); }
    expect(f.state.requests).toBe(0);
    expect(f.state.writes).toBe(0);
  });

  test("corrupt persisted contracts fail closed instead of executing again", async () => {
    const f = await fixture();
    for (const value of [
      null, [], { ...f.result, bytes: 0 }, { ...f.result, bytes: 1048577 },
      { ...f.result, bytes: 1.5 }, { ...f.result, bytes: "1" },
      { ...f.result, sha256: "invalid" }, { ...f.result, extra: "unexpected" },
      { ...f.result, version: 1 }, { ...f.result, version: 3 },
      { ...f.result, reviewId: "other-review" }, { ...f.result, artifactId: "invalid" },
      { ...f.result, artifactId: crypto.randomUUID() },
    ]) {
      await persist(f.input, value);
      await expect(f.job.run(f.input)).rejects.toThrow();
    }
    expect(f.state.requests).toBe(0);
    expect(f.state.writes).toBe(0);
  });

  test("first execution persists normally; concurrent redeliveries converge without overwrites", async () => {
    const f = await fixture();
    expect(await f.adapters.store.readResult(f.input)).toBeNull();
    expect(await Promise.all(Array.from({ length: 4 }, () => f.job.run(f.input))))
      .toEqual(Array.from({ length: 4 }, () => f.result));
    expect(await rows("SELECT count(*)::integer AS count FROM public.starter_attachment_results WHERE review_id=$1",
      [f.input.reviewId])).toEqual([{ count: 1 }]);
    await expect(f.adapters.store.recordAttachment(f.input, { ...f.result, sha256: "0".repeat(64) }))
      .rejects.toThrow("Conflicting");
    expect(await f.adapters.store.readResult(f.input)).toEqual(f.result);
  });

  test("missing results do not hide Storage errors or insert success", async () => {
    const f = await fixture();
    f.state.unavailable = true;
    await expect(f.job.run(f.input)).rejects.toThrow();
    expect(f.state.requests).toBeGreaterThan(0);
    expect(f.state.writes).toBe(0);
    expect(await f.adapters.store.readResult(f.input)).toBeNull();
  });

  test("first execution rejects mismatched artifacts while committed receipts avoid another read", async () => {
    const f = await fixture();
    await rows("UPDATE public.starter_attachments SET object_path='wrong-path' WHERE review_id=$1", [f.input.reviewId]);
    await expect(f.job.run(f.input)).rejects.toThrow("Invalid attachment artifact");
    expect(f.state.writes).toBe(0);
    expect(await f.adapters.store.readResult(f.input)).toBeNull();
    await persist(f.input, f.result);
    f.state.unavailable = true;
    const requests = f.state.requests;
    expect(await f.job.run(f.input)).toEqual(f.result);
    expect(f.state.requests).toBe(requests);
    expect(f.state.writes).toBe(0);
  });

  test("new writes obey the same result contract and read failures do not become cache misses", async () => {
    const f = await fixture();
    for (const result of [{ ...f.result, bytes: 0 }, { ...f.result, extra: "not-in-contract" }]) {
      await expect(f.adapters.store.recordAttachment(f.input, result)).rejects.toThrow();
    }
    const broken = await host.createReviewAttachmentAdapters({
      ...f.options,
      database: {
        transaction: run => f.options.database.transaction(tx => run({
          query(text, parameters) {
            if (text.startsWith("SELECT result FROM")) throw new Error("Database unavailable");
            return tx.query(text, parameters);
          },
        })),
      },
    });
    await expect(new business.VerifyReviewAttachment(broken.store).run(f.input)).rejects.toThrow("Database unavailable");
    expect(f.state.requests).toBe(0);
    expect(f.state.writes).toBe(0);
  });

  test("submission rollback leaves no run to recover", async () => {
    const f = await fixture();
    await expect(database.transaction(async tx => {
      await tx.query("SET LOCAL ROLE starter_review_http");
      await f.adapters.enqueue(tx, f.input.reviewId, f.input.version);
      throw new Error("Business transaction rolled back");
    })).rejects.toThrow("Business transaction rolled back");
    expect(await snapshot(f.runId)).toBeNull();
    expect(await f.adapters.store.readResult(f.input)).toBeNull();
  });
});
