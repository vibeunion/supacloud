export const STARTER_TASK_CONTRACTS = `import { t, type UnwrapSchema } from "elysia";
import { AttachmentResult } from "./attachment";

export const TaskParams = t.Object({ id: t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
export const RetryBody = t.Object({
  expectedVersion: t.Integer({ minimum: 2, maximum: 2147483647 }),
  expectedRunId: t.String({ format: "uuid" }),
  recoveryId: t.String({ format: "uuid" }),
}, { additionalProperties: false });
export const RetryInput = t.Object({
  reviewId: TaskParams.properties.id, ...RetryBody.properties,
}, { additionalProperties: false });
export const TaskStatus = t.Object({
  reviewId: TaskParams.properties.id,
  version: t.Integer({ minimum: 1 }),
  artifactId: t.Nullable(t.String({ format: "uuid" })),
  runId: t.Nullable(t.String({ format: "uuid" })),
  state: t.Union([t.Literal("not_submitted"), t.Literal("queued"), t.Literal("running"),
    t.Literal("completed"), t.Literal("failed"), t.Literal("cancelled")]),
  attempts: t.Integer({ minimum: 0 }),
  maxAttempts: t.Literal(3),
  canRetry: t.Boolean(),
  result: t.Nullable(AttachmentResult),
}, { additionalProperties: false });
export const RetryResult = t.Object({
  reviewId: TaskParams.properties.id,
  previousRunId: t.String({ format: "uuid" }),
  runId: t.String({ format: "uuid" }),
  state: t.Literal("queued"),
}, { additionalProperties: false });
export type ReviewTaskStatus = UnwrapSchema<typeof TaskStatus>;
export type ReviewRetryBody = UnwrapSchema<typeof RetryBody>;
export type ReviewRetryInput = UnwrapSchema<typeof RetryInput>;
export type ReviewRetryResult = UnwrapSchema<typeof RetryResult>;
`;

export const STARTER_TASK_FEATURE = `import { Effect } from "effect";
import { Body, Controller, DB_CLIENT, Get, Inject, Injectable, Param, Post, REQUEST_CONTEXT } from "@supacloud/app";
import { ApplicationError } from "@supacloud/elysia";
import { RetryBody, RetryResult, TaskParams, TaskStatus,
  type ReviewRetryBody, type ReviewRetryInput, type ReviewRetryResult, type ReviewTaskStatus } from "./task-contracts";

export interface ReviewTaskPort {
  attachmentTask(context: unknown, reviewId: string): Promise<ReviewTaskStatus>;
  retryAttachmentTask(context: unknown, input: ReviewRetryInput): Promise<ReviewRetryResult>;
}
type TaskError =
  | { readonly _tag: "AUTHENTICATION_REQUIRED" }
  | { readonly _tag: "TASK_INPUT_INVALID" }
  | { readonly _tag: "TASK_DENIED" }
  | { readonly _tag: "TASK_CONFLICT" }
  | { readonly _tag: "TASK_UNAVAILABLE" }
  | { readonly _tag: "TASK_OUTCOME_UNKNOWN" };

@Injectable({ scope: "request" })
export class ReviewTasks {
  constructor(@Inject(DB_CLIENT) private readonly store: Partial<ReviewTaskPort>,
    @Inject(REQUEST_CONTEXT) private readonly context: unknown) {}

  status(id: string): Promise<ReviewTaskStatus> {
    if (!this.store.attachmentTask) throw new ApplicationError("Attachment tasks are not configured", { status: 501, code: "TASK_UNAVAILABLE" });
    return this.store.attachmentTask(this.context, id);
  }
  retry(input: ReviewRetryInput): Promise<ReviewRetryResult> {
    if (!this.store.retryAttachmentTask) throw new ApplicationError("Attachment tasks are not configured", { status: 501, code: "TASK_UNAVAILABLE" });
    return this.store.retryAttachmentTask(this.context, input);
  }
}

@Controller("/reviews")
export class ReviewTasksController {
  constructor(@Inject(ReviewTasks) private readonly tasks: ReviewTasks) {}

  @Get("/:id/attachment-task", {
    params: TaskParams, responses: { 200: TaskStatus },
    effect: { required: true, dependencies: [], retry: "none", errors: [
      { tag: "AUTHENTICATION_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
      { tag: "TASK_INPUT_INVALID", status: 400, code: "TASK_INPUT_INVALID" },
      { tag: "TASK_DENIED", status: 403, code: "TASK_DENIED" },
      { tag: "TASK_CONFLICT", status: 409, code: "TASK_CONFLICT" },
      { tag: "TASK_UNAVAILABLE", status: 501, code: "TASK_UNAVAILABLE" },
      { tag: "TASK_OUTCOME_UNKNOWN", status: 503, code: "TASK_OUTCOME_UNKNOWN" },
    ] },
  })
  status(@Param("id") id: string): Effect.Effect<ReviewTaskStatus, TaskError, never> {
    return Effect.promise(() => this.tasks.status(id));
  }

  @Post("/:id/attachment-task/retry", {
    params: TaskParams, body: RetryBody, responses: { 200: RetryResult },
    effect: { required: true, dependencies: [], retry: "none", errors: [
      { tag: "AUTHENTICATION_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
      { tag: "TASK_INPUT_INVALID", status: 400, code: "TASK_INPUT_INVALID" },
      { tag: "TASK_DENIED", status: 403, code: "TASK_DENIED" },
      { tag: "TASK_CONFLICT", status: 409, code: "TASK_CONFLICT" },
      { tag: "TASK_UNAVAILABLE", status: 501, code: "TASK_UNAVAILABLE" },
      { tag: "TASK_OUTCOME_UNKNOWN", status: 503, code: "TASK_OUTCOME_UNKNOWN" },
    ] },
  })
  retry(@Param("id") id: string, @Body() body: ReviewRetryBody): Effect.Effect<ReviewRetryResult, TaskError, never> {
    return Effect.promise(() => this.tasks.retry({ ...body, reviewId: id }));
  }
}
`;

export const STARTER_TASK_SCHEMA = `-- Forward-only operator provisioning after 004 and the platform Workflow runtime.
CREATE TABLE public.starter_attachment_retries (
  run_id uuid PRIMARY KEY,
  review_id text NOT NULL REFERENCES public.starter_attachments(review_id),
  previous_run_id uuid NOT NULL UNIQUE,
  generation integer NOT NULL CHECK (generation > 0),
  UNIQUE(review_id,generation),
  CHECK (run_id <> previous_run_id)
);
ALTER TABLE public.starter_attachment_retries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.starter_attachment_retries FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT ON public.starter_attachment_retries TO starter_review_http;
GRANT SELECT ON public.starter_attachment_retries TO starter_review_worker;
DROP POLICY IF EXISTS starter_http_retry_read ON public.starter_attachment_retries;
CREATE POLICY starter_http_retry_read ON public.starter_attachment_retries
  FOR SELECT TO starter_review_http USING (true);
DROP POLICY IF EXISTS starter_http_retry_insert ON public.starter_attachment_retries;
CREATE POLICY starter_http_retry_insert ON public.starter_attachment_retries
  FOR INSERT TO starter_review_http WITH CHECK (true);
DROP POLICY IF EXISTS starter_worker_retry_read ON public.starter_attachment_retries;
CREATE POLICY starter_worker_retry_read ON public.starter_attachment_retries
  FOR SELECT TO starter_review_worker USING (true);
-- Trusted HTTP adapters authorize the review before inspecting its bound run.
GRANT EXECUTE ON FUNCTION supacloud_workflows.snapshot(uuid,boolean) TO starter_review_http;
`;

export const STARTER_TASK_HOST = `import { t } from "elysia";
import { createTransactionalCommand, plaintextCommandInput } from "@supacloud/commands";
import { CommandError } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandDatabase, type CommandTransaction } from "@supacloud/db";
import { ApplicationError, createSchemaDecoder, requireTrustedIdentity } from "@supacloud/elysia";
import { AttachmentInput, AttachmentResult } from "../review/attachment";
import { ReviewResult } from "../review/contracts";
import { RetryInput, RetryResult, TaskParams, TaskStatus, type ReviewRetryInput } from "../review/task-contracts";
import type { ReviewTaskPort } from "../review/tasks";
import type { attachments, attachmentRetries, ReviewRow } from "../../db/schema";

export interface ReviewTaskOptions { database: CommandDatabase; projectId: string; tenantId: string }
type Binding = Pick<typeof attachments.$inferSelect, "artifactId" | "runId">
  & Pick<typeof attachmentRetries.$inferSelect, "generation" | "runId">;
const decodeInput = createSchemaDecoder(RetryInput, { normalize: false });
const decodeRetry = createSchemaDecoder(RetryResult, { normalize: false });
const decodeStatus = createSchemaDecoder(TaskStatus, { normalize: false });
const decodeParams = createSchemaDecoder(TaskParams, { normalize: false });
const decodeReview: (value: unknown) => Pick<ReviewRow, "state" | "version"> =
  createSchemaDecoder(ReviewResult, { normalize: false });
const decodeResult = createSchemaDecoder(AttachmentResult, { normalize: false });
const decodeBinding: (value: unknown) => Binding = createSchemaDecoder(t.Object({
  artifactId: t.String({ format: "uuid" }), runId: t.String({ format: "uuid" }),
  generation: t.Integer({ minimum: 0 }),
}), { normalize: false });
const decodeRun = createSchemaDecoder(t.Object({
  runId: t.String({ format: "uuid" }), workflowName: t.Literal("review.verify-attachment"),
  workflowVersion: t.Literal("1"),
  status: t.Union([t.Literal("queued"), t.Literal("running"), t.Literal("completed"), t.Literal("failed"), t.Literal("cancelled")]),
  input: AttachmentInput, output: t.Unknown(), idempotent: t.Boolean(),
  steps: t.Array(t.Object({
    stepKey: t.Literal("verify"), attempts: t.Integer({ minimum: 0 }),
    maxAttempts: t.Literal(3),
    status: t.Union([t.Literal("queued"), t.Literal("running"), t.Literal("completed"), t.Literal("failed"), t.Literal("dead_lettered"), t.Literal("cancelled")]),
  }, { additionalProperties: true }), { minItems: 1, maxItems: 1 }),
}, { additionalProperties: true }), { normalize: false });
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid task record");
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid task rows");
  return value.map(record);
}
function capture(value: unknown): ReviewRetryInput {
  try {
    const input = decodeInput(value);
    return { ...input, recoveryId: input.recoveryId.toLowerCase(), expectedRunId: input.expectedRunId.toLowerCase() };
  } catch { throw new ApplicationError("Invalid task request", { status: 400, code: "TASK_INPUT_INVALID" }); }
}
function failure(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof CommandError && error.code === "COMMAND_REJECTED") {
    throw new ApplicationError("Task access denied", { status: 403, code: "TASK_DENIED" });
  }
  if (error instanceof CommandError && error.code === "COMMAND_IDEMPOTENCY_CONFLICT") {
    throw new ApplicationError("Task changed or is not retryable", { status: 409, code: "TASK_CONFLICT" });
  }
  throw new ApplicationError("Task outcome could not be confirmed", { status: 503, code: "TASK_OUTCOME_UNKNOWN" });
}
const conflict = () => { throw new CommandError("COMMAND_IDEMPOTENCY_CONFLICT"); };

export async function createReviewTaskAdapters(options: ReviewTaskOptions): Promise<ReviewTaskPort> {
  const { database, projectId, tenantId } = options;
  const configured = rows(await database.transaction(tx => tx.query(
    "SELECT project_id,tenant_id FROM public.starter_application WHERE singleton",
  )));
  if (!projectId.trim() || !tenantId.trim() || configured.length !== 1
    || configured[0]?.["project_id"] !== projectId || configured[0]?.["tenant_id"] !== tenantId) {
    throw new Error("Task database project/tenant binding mismatch");
  }
  function actor(context: unknown): string {
    const who = requireTrustedIdentity(context);
    const access = record(record(context)["access"]);
    if (access["projectId"] !== projectId || access["tenantId"] !== tenantId
      || !Array.isArray(access["permissions"]) || !access["permissions"].includes("review.approve")) {
      throw new ApplicationError("Task access denied", { status: 403, code: "TASK_DENIED" });
    }
    return who.subject;
  }
  async function authorize(tx: CommandTransaction, subject: string, reviewId: string) {
    const found = rows(await tx.query(
      "SELECT r.state,r.version FROM public.starter_reviews r " +
      "JOIN public.starter_members m ON m.subject=r.owner_id CROSS JOIN public.starter_application p " +
      "WHERE r.id=$1 AND r.owner_id=$2 AND m.enabled AND m.can_approve " +
      "AND p.singleton AND p.project_id=$3 AND p.tenant_id=$4 FOR UPDATE OF r,m FOR SHARE OF p",
      [reviewId, subject, projectId, tenantId],
    ));
    if (found.length !== 1) throw new ApplicationError("Task access denied", { status: 403, code: "TASK_DENIED" });
    return decodeReview(found[0]);
  }
  async function binding(tx: CommandTransaction, reviewId: string) {
    const found = rows(await tx.query(
      'SELECT a.artifact_id AS "artifactId",COALESCE(retry.run_id,a.run_id) AS "runId",COALESCE(retry.generation,0) AS generation ' +
      "FROM public.starter_attachments a LEFT JOIN LATERAL (" +
      "SELECT run_id,generation FROM public.starter_attachment_retries WHERE review_id=a.review_id ORDER BY generation DESC LIMIT 1" +
      ") retry ON true WHERE a.review_id=$1", [reviewId],
    ));
    return found.length === 0 ? null : decodeBinding(found[0]);
  }
  async function snapshot(tx: CommandTransaction, runId: string) {
    return rows(await tx.query("SELECT supacloud_workflows.snapshot($1::uuid,false) AS run", [runId]))[0]?.["run"];
  }
  function boundRun(value: unknown, reviewId: string, version: number, bound: NonNullable<Awaited<ReturnType<typeof binding>>>) {
    const run = decodeRun(value);
    if (run.runId !== bound.runId || run.input.reviewId !== reviewId
      || run.input.version !== version || run.input.artifactId !== bound.artifactId) {
      throw new Error("Task Workflow binding mismatch");
    }
    const step = run.steps[0];
    if (!step || (run.status === "queued" && step.status !== "queued")
      || (run.status === "running" && step.status !== "queued" && step.status !== "running")
      || (run.status === "completed" && step.status !== "completed")
      || (run.status === "failed" && step.status !== "failed" && step.status !== "dead_lettered")
      || (run.status === "cancelled" && step.status !== "cancelled")) {
      throw new Error("Task Workflow state mismatch");
    }
    return run;
  }
  const retry = createTransactionalCommand({
    name: "review.retry-attachment", store: createPostgresCommandStore(database),
    inputCodec: plaintextCommandInput, input: capture, result: decodeRetry,
    async authorize(who, input, tx) {
      try {
        const review = await authorize(tx, who.actorId, input.reviewId);
        return review.state === "approved" && review.version === input.expectedVersion ? "allow" : "deny";
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "TASK_DENIED") return "deny";
        throw error;
      }
    },
    async execute(tx, input) {
      const bound = await binding(tx, input.reviewId);
      if (!bound || bound.runId !== input.expectedRunId || input.recoveryId === bound.runId) return conflict();
      const previous = boundRun(await snapshot(tx, bound.runId), input.reviewId, input.expectedVersion, bound);
      if (previous.status !== "failed") return conflict();
      if (await snapshot(tx, input.recoveryId) !== null) return conflict();
      const started = rows(await tx.query(
        "SELECT supacloud_workflows.start_run($1::uuid,'review.verify-attachment','1','verify',$2::text::jsonb,3) AS run",
        [input.recoveryId, JSON.stringify(previous.input)],
      ))[0]?.["run"];
      const next = boundRun(started, input.reviewId, input.expectedVersion, { ...bound, runId: input.recoveryId });
      if (next.idempotent || next.status !== "queued") return conflict();
      await tx.query("INSERT INTO public.starter_attachment_retries(run_id,review_id,previous_run_id,generation) VALUES($1,$2,$3,$4)",
        [input.recoveryId, input.reviewId, bound.runId, bound.generation + 1]);
      return { reviewId: input.reviewId, previousRunId: bound.runId, runId: input.recoveryId, state: "queued" as const };
    },
    audit: { event: "review.attachment-retried", details: input => ({
      reviewId: input.reviewId, previousRunId: input.expectedRunId, runId: input.recoveryId,
    }) },
  });
  return {
    async attachmentTask(context, reviewId) {
      try {
        const subject = actor(context);
        try { decodeParams({ id: reviewId }); }
        catch { throw new ApplicationError("Invalid task request", { status: 400, code: "TASK_INPUT_INVALID" }); }
        return await database.transaction(async tx => {
          const review = await authorize(tx, subject, reviewId);
          const bound = await binding(tx, reviewId);
          const empty = { reviewId, version: review.version, artifactId: bound?.artifactId ?? null,
            runId: null, state: "not_submitted", attempts: 0, maxAttempts: 3, canRetry: false, result: null } as const;
          if (!bound) return decodeStatus(empty);
          const value = await snapshot(tx, bound.runId);
          if (value === null && review.state === "draft" && bound.generation === 0) return decodeStatus(empty);
          const run = boundRun(value, reviewId, review.version, bound);
          const step = run.steps[0];
          if (!step) throw new Error("Missing task step");
          const result = run.status === "completed" ? decodeResult(run.output) : null;
          if (result && (result.reviewId !== reviewId || result.version !== review.version || result.artifactId !== bound.artifactId)) {
            throw new Error("Task result binding mismatch");
          }
          return decodeStatus({ ...empty, runId: run.runId,
            state: run.status === "running" && step.status === "queued" ? "queued" : run.status,
            attempts: step.attempts, canRetry: run.status === "failed", result });
        });
      } catch (error) { return failure(error); }
    },
    async retryAttachmentTask(context, value) {
      try {
        const subject = actor(context), input = capture(value);
        const receipt = await retry.execute({ actorId: subject, tenantId }, input.recoveryId, input);
        if (receipt.status !== "confirmed") throw new CommandError("COMMAND_OUTCOME_UNKNOWN");
        return receipt.result;
      } catch (error) { return failure(error); }
    },
  };
}
`;
