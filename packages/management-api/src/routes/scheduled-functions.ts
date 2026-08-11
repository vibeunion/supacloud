/**
 * Scheduled Edge Functions routes.
 *
 * Stores schedule config under `projects.config.scheduled_functions` and exposes
 * CRUD + manual trigger. An in-process scheduler (scheduled-function.worker.ts)
 * evaluates cron expressions and POSTs to the edge runtime on schedule.
 *
 * This mirrors the Supabase product experience of scheduling functions from the
 * dashboard, without requiring users to hand-write pg_cron + pg_net SQL.
 */
import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { config } from "../config";
import { logger } from "../utils/logger";
import {
  MAX_SCHEDULES_PER_PROJECT,
  scheduledFunctionService,
  type ScheduledFunctionPatch,
} from "../services/scheduled-function.service";
import { scheduledFunctionWorker } from "../workers/scheduled-function.worker";
import { isValidScheduledFunctionCron } from "../utils/scheduled-function-cron";
import {
  normalizedScheduledFunctionHeaders,
  SCHEDULE_HEADERS_INVALID,
} from "../utils/scheduled-function-headers";
import {
  isCanonicalScheduledFunctionTimestamp,
  MAX_SCHEDULE_NAME_LENGTH,
  normalizedScheduledFunctionName,
  normalizedScheduledFunctionSlug,
  publicScheduledFunction,
  scheduledFunctionBodyWithinLimit,
  scheduledFunctionsFromProjectConfig,
  type ScheduledFunctionConfig,
  type ScheduledFunctionMethod,
} from "../utils/scheduled-function-config";

export type { ScheduledFunctionConfig, ScheduledFunctionMethod } from "../utils/scheduled-function-config";

const ALLOWED_METHODS: ReadonlySet<ScheduledFunctionMethod> = new Set(["GET", "POST"]);
const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SCHEDULE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCHEDULE_BODY_INVALID = "SCHEDULE_BODY_INVALID";
const SCHEDULE_PATCH_FIELDS = ["name", "cron", "method", "body", "headers", "enabled"] as const;

interface ScheduleCreateInput {
  request_id: string;
  name: string;
  slug: string;
  cron: string;
  method: ScheduledFunctionMethod;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

type SchedulePatchInput = Partial<Pick<
  ScheduledFunctionConfig,
  "name" | "cron" | "method" | "body" | "headers" | "enabled"
>> & { request_id: string; expected_updated_at: string };

function validatedScheduleCreateInput(
  input: ScheduleCreateInput,
): { error: string } | { name: string; slug: string; cron: string } {
  if (!input.request_id || !SCHEDULE_ID_PATTERN.test(input.request_id)) {
    return { error: "request_id must be a UUIDv4" };
  }
  const name = normalizedScheduledFunctionName(input.name);
  if (!name) return { error: `name must be 1-${MAX_SCHEDULE_NAME_LENGTH} characters` };
  const slug = normalizedScheduledFunctionSlug(input.slug);
  if (!slug) return { error: "slug must be 1-128 alphanumeric/dash/underscore characters" };
  const cron = typeof input.cron === "string" ? input.cron.trim() : "";
  if (!isValidScheduledFunctionCron(cron)) return { error: "cron must be a valid bounded 5-field expression" };
  if (!ALLOWED_METHODS.has(input.method)) {
    return { error: `method must be one of: ${[...ALLOWED_METHODS].join(", ")}` };
  }
  if (!scheduledFunctionBodyWithinLimit(input.body)) return { error: SCHEDULE_BODY_INVALID };
  return { name, slug, cron };
}

function schedulePatchError(input: SchedulePatchInput): string | null {
  if (!SCHEDULE_ID_PATTERN.test(input.request_id)) return "request_id must be a UUIDv4";
  if (!isCanonicalScheduledFunctionTimestamp(input.expected_updated_at)) {
    return "expected_updated_at must be a canonical UTC timestamp";
  }
  if (!SCHEDULE_PATCH_FIELDS.some((field) => input[field] !== undefined)) {
    return "Scheduled function update requires at least one field";
  }
  if (input.name !== undefined && !normalizedScheduledFunctionName(input.name)) {
    return `name must be 1-${MAX_SCHEDULE_NAME_LENGTH} characters`;
  }
  if (input.cron !== undefined && !isValidScheduledFunctionCron(input.cron.trim())) {
    return "cron must be a valid bounded 5-field expression";
  }
  if (input.method !== undefined && !ALLOWED_METHODS.has(input.method)) return "method must be GET or POST";
  if (!scheduledFunctionBodyWithinLimit(input.body)) return SCHEDULE_BODY_INVALID;
  return null;
}

function normalizedSchedulePatch(
  input: SchedulePatchInput,
  headers: Record<string, string> | undefined,
): ScheduledFunctionPatch {
  return {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.cron !== undefined ? { cron: input.cron.trim() } : {}),
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.headers !== undefined && headers ? { headers } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
}

function scheduleHeaders(
  candidate: Record<string, string> | undefined,
): Record<string, string> | null | undefined {
  return candidate === undefined ? undefined : normalizedScheduledFunctionHeaders(candidate);
}

export const scheduledFunctionRoutes = new Elysia({ prefix: "/v1/projects/:ref/scheduled-functions" })
  .onBeforeHandle(async ({ params, request }) => {
    if (!PROJECT_REF_PATTERN.test(params.ref)) return status(400, { error: "Project ref is invalid" });
    const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });
    const schedules = scheduledFunctionsFromProjectConfig(project.config).map(publicScheduledFunction);
    return { project_ref: params.ref, schedules };
  }, {
    detail: { tags: ["scheduled-functions"], summary: "List scheduled functions" },
  })
  .get("/:scheduleId", async ({ params }) => {
    if (!SCHEDULE_ID_PATTERN.test(params.scheduleId)) return status(400, { error: "Scheduled function ID is invalid" });
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });
    const schedule = scheduledFunctionsFromProjectConfig(project.config)
      .find((candidate) => candidate.id === params.scheduleId);
    if (!schedule) return status(404, { error: "Scheduled function not found" });
    return { project_ref: params.ref, schedule: publicScheduledFunction(schedule) };
  }, {
    detail: { tags: ["scheduled-functions"], summary: "Get a scheduled function" },
  })
  .post("", async ({ params, body }) => {
    const input = body as ScheduleCreateInput;
    const validation = validatedScheduleCreateInput(input);
    if ("error" in validation) return status(400, validation);
    const headers = scheduleHeaders(input.headers);
    if (headers === null) return status(400, { error: SCHEDULE_HEADERS_INVALID });

    const now = new Date().toISOString();
    const schedule: ScheduledFunctionConfig = {
      id: crypto.randomUUID(),
      name: validation.name,
      slug: validation.slug,
      cron: validation.cron,
      method: input.method,
      body: input.body,
      headers: headers ?? undefined,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    const mutation = await scheduledFunctionService.create({ ref: params.ref, schedule });
    if (mutation.kind === "project_not_found") return status(404, { error: "Project not found" });
    if (mutation.kind === "limit_reached") {
      return status(400, { error: `A project can have at most ${MAX_SCHEDULES_PER_PROJECT} scheduled functions` });
    }
    if (mutation.kind === "duplicate") {
      return status(409, {
        code: mutation.field === "name" ? "SCHEDULE_NAME_CONFLICT" : "SCHEDULE_SLUG_CONFLICT",
        error: `A schedule with ${mutation.field} '${schedule[mutation.field]}' already exists`,
      });
    }

    scheduledFunctionWorker.reload();
    return {
      created: true,
      project_ref: params.ref,
      request_id: input.request_id,
      schedule: publicScheduledFunction(mutation.schedule),
    };
  }, {
    body: t.Object({
      request_id: t.String(),
      name: t.String(),
      slug: t.String(),
      cron: t.String(),
      method: t.Union([t.Literal("GET"), t.Literal("POST")]),
      body: t.Optional(t.Record(t.String(), t.Unknown())),
      headers: t.Optional(t.Record(t.String(), t.String())),
    }),
    detail: { tags: ["scheduled-functions"], summary: "Create a scheduled function" },
  })
  .patch("/:scheduleId", async ({ params, body }) => {
    if (!SCHEDULE_ID_PATTERN.test(params.scheduleId)) return status(400, { error: "Scheduled function ID is invalid" });
    const input = body as SchedulePatchInput;
    const validationError = schedulePatchError(input);
    if (validationError) return status(400, { error: validationError });
    const headers = scheduleHeaders(input.headers);
    if (headers === null) return status(400, { error: SCHEDULE_HEADERS_INVALID });

    const mutation = await scheduledFunctionService.update({
      ref: params.ref,
      scheduleId: params.scheduleId,
      expectedUpdatedAt: input.expected_updated_at,
      patch: normalizedSchedulePatch(input, headers),
    });
    if (mutation.kind === "project_not_found") return status(404, { error: "Project not found" });
    if (mutation.kind === "schedule_not_found") return status(404, { error: "Scheduled function not found" });
    if (mutation.kind === "revision_conflict") {
      return status(409, { code: "SCHEDULE_REVISION_CONFLICT", error: "Scheduled function revision conflict" });
    }
    if (mutation.kind === "duplicate") {
      return status(409, { code: "SCHEDULE_NAME_CONFLICT", error: "A schedule with that name already exists" });
    }

    scheduledFunctionWorker.reload();
    return {
      updated: true,
      project_ref: params.ref,
      request_id: input.request_id,
      previous_updated_at: input.expected_updated_at,
      schedule: publicScheduledFunction(mutation.schedule),
    };
  }, {
    body: t.Object({
      request_id: t.String(),
      expected_updated_at: t.String(),
      name: t.Optional(t.String()),
      cron: t.Optional(t.String()),
      method: t.Optional(t.Union([t.Literal("GET"), t.Literal("POST")])),
      body: t.Optional(t.Record(t.String(), t.Unknown())),
      headers: t.Optional(t.Record(t.String(), t.String())),
      enabled: t.Optional(t.Boolean()),
    }),
    detail: { tags: ["scheduled-functions"], summary: "Update a scheduled function" },
  })
  .delete("/:scheduleId", async ({ params, query }) => {
    if (!SCHEDULE_ID_PATTERN.test(params.scheduleId)) return status(400, { error: "Scheduled function ID is invalid" });
    if (!isCanonicalScheduledFunctionTimestamp(query.expected_updated_at)) {
      return status(400, { error: "expected_updated_at must be a canonical UTC timestamp" });
    }
    const mutation = await scheduledFunctionService.delete({
      ref: params.ref,
      scheduleId: params.scheduleId,
      expectedUpdatedAt: query.expected_updated_at,
    });
    if (mutation.kind === "project_not_found") return status(404, { error: "Project not found" });
    if (mutation.kind === "schedule_not_found") return status(404, { error: "Scheduled function not found" });
    if (mutation.kind === "revision_conflict") {
      return status(409, { code: "SCHEDULE_REVISION_CONFLICT", error: "Scheduled function revision conflict" });
    }

    scheduledFunctionWorker.reload();
    return {
      deleted: true,
      project_ref: params.ref,
      schedule_id: params.scheduleId,
      deleted_updated_at: mutation.deletedUpdatedAt,
    };
  }, {
    query: t.Object({ expected_updated_at: t.String() }),
    detail: { tags: ["scheduled-functions"], summary: "Delete a scheduled function" },
  })
  .post("/:scheduleId/trigger", async ({ params }) => {
    if (!SCHEDULE_ID_PATTERN.test(params.scheduleId)) return status(400, { error: "Scheduled function ID is invalid" });
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });

    const schedules = scheduledFunctionsFromProjectConfig(project.config);
    const target = schedules.find((schedule) => schedule.id === params.scheduleId);
    if (!target) return status(404, { error: "Scheduled function not found" });

    const invocation = await scheduledFunctionWorker.triggerOnce(params.ref, target);
    if (!invocation.ok) return status(502, { error: invocation.error });
    return { triggered: true, project_ref: params.ref, schedule_id: params.scheduleId, status: invocation.status };
  }, {
    detail: { tags: ["scheduled-functions"], summary: "Manually trigger a scheduled function" },
  });
