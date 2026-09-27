export const STARTER_ATTACHMENT_WORKER = `import { createWorker, type CompiledModule } from "@supacloud/elysia";
import type { SupaCloudWorkflowClaim, SupaCloudWorkflowsClient } from "@supacloud/js";
import { createReviewAttachmentAdapters, type ReviewAttachmentOptions } from "./review-attachments";

export interface ReviewAttachmentWorkerOptions extends ReviewAttachmentOptions {
  modules: readonly CompiledModule[];
  workflows: Pick<SupaCloudWorkflowsClient, "claim" | "complete" | "retry" | "fail">;
  workerId: string;
  queueOwnership: "exclusive-review-attachments";
  pollIntervalMs?: number;
}

export async function createReviewAttachmentWorker(options: ReviewAttachmentWorkerOptions) {
  if (options.queueOwnership !== "exclusive-review-attachments") {
    throw new Error("Attachment worker requires an exclusively owned Workflow queue");
  }
  const { store } = await createReviewAttachmentAdapters(options);
  const { workflows, workerId } = options;
  const failure = Promise.withResolvers<never>();
  // The executable attaches its fatal listener after this async factory returns.
  void failure.promise.catch(() => {});
  let halted: boolean = false;
  const fatal = () => {
    halted = true;
    failure.reject(new Error("Attachment worker requires recovery"));
  };
  const attempt = (claim: SupaCloudWorkflowClaim) => ({
    stepId: claim.stepId, messageId: claim.messageId, attempt: claim.attempt, workerId: claim.workerId,
  });
  async function ownedClaim(claim: SupaCloudWorkflowClaim) {
    if (claim.workflowName !== "review.verify-attachment" || claim.workflowVersion !== "1"
      || claim.stepKey !== "verify" || claim.maxAttempts !== 3 || claim.workerId !== workerId) {
      throw new Error("Unsupported attachment workflow");
    }
    const { reviewId, artifactId } = claim.input;
    if (typeof reviewId !== "string" || typeof artifactId !== "string") {
      throw new Error("Invalid attachment workflow input");
    }
    const bound = await options.database.transaction(tx => tx.query(
      "SELECT run_id FROM public.starter_attachments WHERE review_id=$1 AND artifact_id=$2 AND run_id=$3",
      [reviewId, artifactId, claim.runId],
    ));
    if (!Array.isArray(bound) || bound.length !== 1) throw new Error("Attachment workflow ownership mismatch");
  }
  const worker = createWorker({
    modules: options.modules, deps: { dbClient: store }, workerId, concurrency: 1,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    onError: fatal,
    transport: {
      async claim(signal): Promise<SupaCloudWorkflowClaim | null> {
        if (halted || signal.aborted) return null;
        try {
          const claim = await workflows.claim({ workerId, visibilityTimeoutSeconds: 120 });
          if (signal.aborted || halted) return null;
          if (!claim || claim.status !== "claimed") return null;
          await ownedClaim(claim);
          return claim;
        } catch {
          if (!signal.aborted) fatal();
          throw new Error("Attachment workflow claim failed");
        }
      },
      async ack(claim, output) {
        try {
          if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Invalid Job output");
          // The compiled Job validates output; Workflow SDK validates the receipt.
          await workflows.complete({ ...attempt(claim), runOutput: { ...output } });
        } catch {
          fatal();
          throw new Error("Attachment workflow completion is unconfirmed");
        }
      },
      async fail(claim) {
        try {
          const request: Parameters<typeof workflows.fail>[0] = { ...attempt(claim), errorMessage: "Attachment verification failed" };
          if (claim.attempt < claim.maxAttempts) await workflows.retry({ ...request, delaySeconds: 5 });
          else await workflows.fail(request);
        } catch {
          fatal();
          throw new Error("Attachment workflow failure receipt is unconfirmed");
        }
      },
    },
    mapClaim: claim => ({
      id: claim.stepId, jobName: claim.workflowName, input: claim.input, attempt: claim.attempt,
      requestContext: { workerId, jobId: claim.stepId, requestId: claim.runId },
    }),
  });
  if (worker.jobNames.length !== 1 || worker.jobNames[0] !== "review.verify-attachment") {
    throw new Error("Attachment worker requires its compiled reference Job");
  }
  let closing: Promise<void> | undefined;
  return {
    failure: failure.promise,
    async start() {
      if (halted) throw new Error("Attachment worker is not startable");
      await worker.start();
    },
    close() {
      halted = true;
      return closing ??= worker.stop();
    },
  };
}
`;

export const STARTER_ATTACHMENT_DELIVERY_WORKER = `import { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import { SupaCloudWorkflowsClient } from "@supacloud/js";
import { createBunCommandDatabase } from "@supacloud/db/bun";
import type { CompiledModule } from "@supacloud/elysia";
import { createReviewAttachmentWorker } from "./host/review-attachment-worker";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error("Missing required worker setting: " + name);
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

export async function createDeliveryWorker(modules: CompiledModule[], lifecycle: { signal: AbortSignal }) {
  lifecycle.signal.throwIfAborted();
  if (required("REVIEW_QUEUE_OWNERSHIP") !== "exclusive-review-attachments") {
    throw new Error("Attachment worker requires an exclusively owned Workflow queue");
  }
  const connection = databaseConnection();
  const settings = {
    projectId: required("SUPACLOUD_PROJECT_ID"), tenantId: required("APP_TENANT_ID"),
    workerId: required("REVIEW_WORKER_ID"), url: required("SUPACLOUD_URL"), key: required("SUPACLOUD_SERVICE_ROLE_KEY"),
  };
  const service = createClient(settings.url, settings.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const pool = new SQL({ ...connection, max: 4, connectionTimeout: 5 });
  let closing: Promise<void> | undefined;
  const closePool = () => closing ??= pool.close({ timeout: 5 });
  try {
    const worker = await createReviewAttachmentWorker({
      database: createBunCommandDatabase(pool), service, projectId: settings.projectId,
      tenantId: settings.tenantId, modules, workerId: settings.workerId,
      workflows: new SupaCloudWorkflowsClient(service), queueOwnership: "exclusive-review-attachments",
    });
    lifecycle.signal.throwIfAborted();
    return {
      start: () => worker.start(), failure: worker.failure,
      async close() { try { await worker.close(); } finally { await closePool(); } },
    };
  } catch (error) {
    await closePool();
    const code = error !== null && typeof error === "object" && "code" in error
      && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "UNKNOWN";
    console.error(JSON.stringify({ event: "review-worker-initialization-failed", code }));
    throw new Error("Attachment worker initialization failed");
  }
}
`;
