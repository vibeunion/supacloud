export const STARTER_REVIEW_SCHEMA = `-- Apply with the platform migration owner, never from the HTTP process.
-- One application database belongs to one explicitly provisioned project/tenant.
CREATE TABLE public.starter_application (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  project_id text NOT NULL CHECK (length(project_id) > 0),
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0)
);
CREATE TABLE public.starter_reviews (
  id text PRIMARY KEY, owner_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','approved')),
  version integer NOT NULL CHECK (version > 0)
);
CREATE TABLE public.starter_members (
  subject text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true,
  can_approve boolean NOT NULL DEFAULT false
);
ALTER TABLE public.starter_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.starter_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.starter_members ENABLE ROW LEVEL SECURITY;
`;

export const STARTER_REVIEW_POSTGRES = `import { AsyncLocalStorage } from "node:async_hooks";
import { createTransactionalCommand, plaintextCommandInput } from "@supacloud/commands";
import { CommandError } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandDatabase, type CommandTransaction } from "@supacloud/db";
import {
  ApplicationError, createSupAuthRequestContext, requireTrustedIdentity, requireIdempotencyKey,
  type CommandInvocation, type SupAuthContextOptions,
} from "@supacloud/elysia";
import type { AppAdapters } from "../application";
import type { ReviewStore } from "../review/review";
import type { ReviewUploadPort } from "../review/uploads";

interface Approval { id: string; expectedVersion: number }
interface Review { state: "draft" | "approved"; version: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Invalid review record");
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid database result");
  return value.map(record);
}
function input(value: unknown): Approval {
  const item = record(value);
  if (typeof item.id !== "string" || !item.id.length || typeof item.expectedVersion !== "number"
    || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 1) throw new TypeError("Invalid approval input");
  return { id: item.id, expectedVersion: item.expectedVersion };
}
function result(value: unknown): Review {
  const item = record(value);
  if ((item.state !== "draft" && item.state !== "approved") || typeof item.version !== "number"
    || !Number.isSafeInteger(item.version) || item.version < 1) throw new TypeError("Invalid review result");
  return { state: item.state, version: item.version };
}

export interface ReviewPostgresOptions {
  database: CommandDatabase;
  tenantId: string;
  identity: Omit<SupAuthContextOptions, "resolveAccess">;
  uploads?: ReviewUploadPort;
  // Only database effects here: they commit/rollback with the approval and receipt.
  afterApproved?(tx: CommandTransaction, id: string, version: number): Promise<void>;
}

export async function createReviewPostgresAdapters(options: ReviewPostgresOptions): Promise<
  AppAdapters & { requestContext: ReturnType<typeof createSupAuthRequestContext> }
> {
  const { database, tenantId, identity } = options;
  const projectId = identity.projectId;
  const afterApproved = options.afterApproved;
  if (!tenantId.trim()) throw new TypeError("Review tenantId is required");
  const query = (text: string, parameters: readonly string[] = []) =>
    database.transaction(tx => tx.query(text, parameters));
  const binding = rows(await query(
    "SELECT project_id,tenant_id FROM public.starter_application WHERE singleton",
  ));
  if (binding.length !== 1 || binding[0]?.project_id !== projectId || binding[0]?.tenant_id !== tenantId) {
    throw new Error("Review database project/tenant binding mismatch");
  }
  const requestContext = createSupAuthRequestContext({
    ...identity,
    async resolveAccess(who) {
      const found = rows(await query(
        "SELECT m.can_approve FROM public.starter_members m,public.starter_application a " +
        "WHERE m.subject=$1 AND m.enabled AND a.singleton AND a.project_id=$2 AND a.tenant_id=$3",
        [who.subject, projectId, tenantId],
      ));
      return found.length === 1 ? { projectId, tenantId,
        permissions: found[0]?.can_approve === true ? ["review.approve"] : [],
      } : null;
    },
  });
  const scope = new AsyncLocalStorage<CommandTransaction>();
  const transaction = () => {
    const tx = scope.getStore();
    if (!tx) throw new Error("Review storage requires its durable command transaction");
    return tx;
  };
  const store: ReviewStore = {
    ...options.uploads,
    async get(table, id) {
      if (table !== "reviews") throw new Error("Unsupported review table");
      return rows(await transaction().query(
        "SELECT state,version FROM public.starter_reviews WHERE id=$1 FOR UPDATE", [id],
      ))[0];
    },
    async set(table, id, value) {
      if (table !== "reviews") throw new Error("Unsupported review table");
      const review = result(value);
      const updated = rows(await transaction().query(
        "UPDATE public.starter_reviews SET state=$2,version=$3 WHERE id=$1 RETURNING id",
        [id, review.state, review.version],
      ));
      if (updated.length !== 1) throw new Error("Review write did not update one record");
      await afterApproved?.(transaction(), id, review.version);
    },
  };
  function actor(invocation: CommandInvocation): string {
    const who = requireTrustedIdentity(invocation.requestContext);
    const access = record(record(invocation.requestContext).access);
    if (access.projectId !== projectId || access.tenantId !== tenantId
      || !Array.isArray(access.permissions) || !access.permissions.includes("review.approve")) {
      throw new ApplicationError("Command permission denied", { status: 403, code: "REVIEW_PERMISSION_DENIED" });
    }
    return who.subject;
  }
  const commandStore = createPostgresCommandStore(database);
  return {
    deps: { dbClient: store }, requestContext,
    commandGovernance: {
      authorize(invocation) {
        const command = invocation.command;
        if (command.name !== "review.approve" || command.permission !== "review.approve"
          || command.transaction !== "required" || command.idempotency !== "required"
          || command.audit !== "review.approved" || command.rpc !== undefined) {
          throw new ApplicationError("Unsupported review command", { status: 501, code: "REVIEW_COMMAND_UNSUPPORTED" });
        }
        actor(invocation);
      },
      async idempotency(invocation, next) {
        const command = createTransactionalCommand({
          name: invocation.command.name, store: commandStore,
          inputCodec: plaintextCommandInput, input, result,
          async authorize(who, request, tx) {
            const found = rows(await tx.query(
              "SELECT r.id FROM public.starter_reviews r JOIN public.starter_members m ON m.subject=r.owner_id " +
              "CROSS JOIN public.starter_application a " +
              "WHERE r.id=$1 AND r.owner_id=$2 AND m.enabled AND m.can_approve " +
              "AND a.singleton AND a.project_id=$3 AND a.tenant_id=$4 FOR UPDATE OF r,m FOR SHARE OF a",
              [request.id, who.actorId, projectId, who.tenantId],
            ));
            return found.length === 1 ? "allow" : "deny";
          },
          execute: tx => scope.run(tx, async () => {
            try { return await next(); }
            catch (error) {
              if (error instanceof ApplicationError && error.status === 409) {
                throw new CommandError("COMMAND_IDEMPOTENCY_CONFLICT");
              }
              throw error;
            }
          }),
          audit: { event: "review.approved", details: request => ({ reviewId: request.id }) },
        });
        try {
          const receipt = await command.execute(
            { actorId: actor(invocation), tenantId }, requireIdempotencyKey(invocation),
            { id: invocation.input.params.id, expectedVersion: record(invocation.input.body).expectedVersion },
            invocation.request.signal,
          );
          if (receipt.status !== "confirmed") throw new CommandError("COMMAND_OUTCOME_UNKNOWN");
          return receipt.result;
        } catch (error) {
          if (!(error instanceof CommandError)) throw error;
          const status = error.code === "COMMAND_REJECTED" ? 403
            : error.code === "COMMAND_IDEMPOTENCY_CONFLICT" ? 409 : 503;
          throw new ApplicationError(error.code, { code: error.code, status });
        }
      },
      transaction(_invocation, next) { transaction(); return next(); },
      // The durable command owns the authoritative audit and receipt in the same transaction.
      audit: { succeeded() { transaction(); }, failed() {} },
    },
  };
}
`;

export const STARTER_REVIEW_POSTGRES_TEST = `import { expect, test } from "bun:test";
import { createReviewPostgresAdapters } from "../src/host/review-postgres";
import type { ReviewStore } from "../src/review/review";

const identity = {
  issuer: "https://identity.example.test", audience: "review-test", clientId: "review-client",
  projectId: "review-test", jwksUrl: "https://identity.example.test/jwks",
};
function database(binding: unknown) {
  const queries: string[] = [];
  return {
    queries,
    async transaction<T>(run: (tx: { query(text: string): Promise<unknown> }) => Promise<T>): Promise<T> {
      return run({ async query(text) { queries.push(text); return binding; } });
    },
  };
}

test("PostgreSQL host rejects missing or mismatched application ownership without creating data", async () => {
  for (const binding of [[], [{ project_id: "other", tenant_id: "review-test" }],
    [{ project_id: "review-test", tenant_id: "other" }]]) {
    const db = database(binding);
    await expect(createReviewPostgresAdapters({ database: db, identity, tenantId: "review-test" }))
      .rejects.toThrow("binding mismatch");
    expect(db.queries).toEqual(["SELECT project_id,tenant_id FROM public.starter_application WHERE singleton"]);
  }
});

test("PostgreSQL host never falls back to demo identity or unbound business storage", async () => {
  const db = database([{ project_id: "review-test", tenant_id: "review-test" }]);
  const adapters = await createReviewPostgresAdapters({ database: db, identity, tenantId: "review-test" });
  await expect(adapters.requestContext(new Request("http://localhost/reviews/health")))
    .rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  const store = adapters.deps.dbClient as ReviewStore;
  await expect(store.get("reviews", "example")).rejects.toThrow("durable command transaction");
  await expect(store.set("reviews", "example", { state: "approved", version: 2 }))
    .rejects.toThrow("durable command transaction");
  expect(db.queries).toHaveLength(1);
});
`;

export const STARTER_REVIEW_DELIVERY_HOST = `import { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import { createBunCommandDatabase } from "@supacloud/db/bun";
import { createApplication, type CompiledModule } from "@supacloud/elysia";
import { createReviewPostgresAdapters } from "./host/review-postgres";
import { createReviewAttachmentAdapters } from "./host/review-attachments";
import { createReviewUploadAdapters } from "./host/review-uploads";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error("Missing required host setting: " + name);
  return value;
}

function databaseConnection(): SQL.Options {
  const socket = process.env.DATABASE_SOCKET_PATH;
  if (socket && process.env.DATABASE_URL) throw new Error("Conflicting database connection settings");
  if (socket) {
    return { adapter: "postgres", path: socket, database: required("DATABASE_NAME"), username: required("DATABASE_USER") };
  }
  const url = new URL(required("DATABASE_URL"));
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("Invalid database URL");
  return {
    adapter: "postgres", url: url.href, hostname: url.hostname.replace(/^\\[|\\]$/g, ""), port: Number(url.port || 5432),
    username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

export async function createDeliveryApplication(modules: CompiledModule[], lifecycle: { signal: AbortSignal }) {
  lifecycle.signal.throwIfAborted();
  const connection = databaseConnection();
  const attachments = process.env.REVIEW_ATTACHMENTS;
  if (attachments !== undefined && attachments !== "enabled") throw new Error("Invalid attachment configuration");
  const settings = {
    tenantId: required("APP_TENANT_ID"),
    identity: {
      issuer: required("SUPAUTH_ISSUER"), audience: required("SUPAUTH_AUDIENCE"),
      clientId: required("SUPAUTH_CLIENT_ID"), projectId: required("SUPACLOUD_PROJECT_ID"),
      jwksUrl: required("SUPAUTH_JWKS_URL"),
    },
  };
  const pool = new SQL({ ...connection, max: 12, connectionTimeout: 5 });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= pool.close({ timeout: 5 });
  let stage: "attachments" | "uploads" | "postgres" | "application" = "attachments";
  try {
    const database = createBunCommandDatabase(pool);
    const attachmentOptions = attachments === "enabled" ? {
      database, tenantId: settings.tenantId, projectId: settings.identity.projectId,
      service: createClient(required("SUPACLOUD_URL"), required("SUPACLOUD_SERVICE_ROLE_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    } : undefined;
    const durable = attachmentOptions ? await createReviewAttachmentAdapters(attachmentOptions) : undefined;
    stage = "uploads";
    const uploads = attachmentOptions ? await createReviewUploadAdapters(attachmentOptions) : undefined;
    stage = "postgres";
    const adapters = await createReviewPostgresAdapters({
      database, tenantId: settings.tenantId, identity: settings.identity, uploads,
      afterApproved: durable?.enqueue,
    });
    lifecycle.signal.throwIfAborted();
    stage = "application";
    const app = createApplication({ name: "review", modules, ...adapters });
    return { fetch: (request: Request) => app.handle(request), close };
  } catch (error) {
    await close();
    const code = error !== null && typeof error === "object" && "code" in error
      && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "UNKNOWN";
    console.error(JSON.stringify({ event: "review-host-initialization-failed", stage, code }));
    // Database/identity errors can contain connection details; never echo the underlying cause.
    throw new Error("Review host initialization failed");
  }
}
`;
