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
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { config } from "../config";
import { logger } from "../utils/logger";
import { scheduledFunctionWorker } from "../workers/scheduled-function.worker";

export type ScheduledFunctionMethod = "GET" | "POST";

export interface ScheduledFunctionConfig {
  id: string;
  name: string;
  slug: string;
  cron: string;
  method: ScheduledFunctionMethod;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

const ALLOWED_METHODS: ReadonlySet<ScheduledFunctionMethod> = new Set(["GET", "POST"]);
const MAX_SCHEDULES_PER_PROJECT = 20;

// Basic 5-field cron validation (does not validate semantic correctness like Feb 30).
const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

function isScheduledFunctionConfig(value: unknown): value is ScheduledFunctionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.slug === "string" &&
    typeof item.cron === "string" &&
    typeof item.method === "string" &&
    ALLOWED_METHODS.has(item.method as ScheduledFunctionMethod) &&
    typeof item.enabled === "boolean"
  );
}

function readSchedules(projectConfig: unknown): ScheduledFunctionConfig[] {
  const cfg = normalizeProjectConfig(projectConfig as Record<string, unknown> | null | undefined);
  const raw = cfg.scheduled_functions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isScheduledFunctionConfig);
}

function validateScheduleInput(input: {
  name?: string;
  slug?: string;
  cron?: string;
  method?: string;
}): string | null {
  if (!input.name?.trim()) return "name is required";
  if (!input.slug?.trim() || !/^[a-z0-9_-]+$/i.test(input.slug)) return "slug must be alphanumeric/dash/underscore";
  if (!input.cron?.trim() || !CRON_RE.test(input.cron.trim())) return "cron must be a valid 5-field expression";
  if (input.method && !ALLOWED_METHODS.has(input.method as ScheduledFunctionMethod)) {
    return `method must be one of: ${[...ALLOWED_METHODS].join(", ")}`;
  }
  return null;
}

function publicSafeSchedule(s: ScheduledFunctionConfig) {
  return { ...s };
}

export const scheduledFunctionRoutes = new Elysia({ prefix: "/v1/projects/:ref/scheduled-functions" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });
    const schedules = readSchedules(project.config).map(publicSafeSchedule);
    return { project_ref: params.ref, schedules };
  }, {
    detail: { tags: ["scheduled-functions"], summary: "List scheduled functions" },
  })
  .post("", async ({ params, body }) => {
    const input = body as { name: string; slug: string; cron: string; method: ScheduledFunctionMethod; body?: Record<string, unknown>; headers?: Record<string, string> };
    const err = validateScheduleInput(input);
    if (err) return status(400, { error: err });

    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });

    const existing = readSchedules(project.config);
    if (existing.length >= MAX_SCHEDULES_PER_PROJECT) {
      return status(400, { error: `A project can have at most ${MAX_SCHEDULES_PER_PROJECT} scheduled functions` });
    }
    if (existing.some((s) => s.slug === input.slug)) {
      return status(409, { error: `A schedule for slug '${input.slug}' already exists` });
    }

    const now = new Date().toISOString();
    const schedule: ScheduledFunctionConfig = {
      id: crypto.randomUUID(),
      name: input.name.trim().slice(0, 120),
      slug: input.slug.trim(),
      cron: input.cron.trim(),
      method: input.method,
      body: input.body,
      headers: input.headers,
      enabled: true,
      created_at: now,
      updated_at: now,
    };

    const updated = await projectRepository.updateConfig(
      params.ref,
      mergeProjectConfig(project.config, { scheduled_functions: [...existing, schedule] }),
    );
    if (!updated) return status(404, { error: "Project not found" });

    scheduledFunctionWorker.reload();
    return { created: true, project_ref: params.ref, schedule: publicSafeSchedule(schedule) };
  }, {
    body: t.Object({
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
    const input = body as Partial<Pick<ScheduledFunctionConfig, "name" | "cron" | "method" | "body" | "headers" | "enabled">>;

    if (input.cron !== undefined && !CRON_RE.test(input.cron.trim())) {
      return status(400, { error: "cron must be a valid 5-field expression" });
    }
    if (input.method !== undefined && !ALLOWED_METHODS.has(input.method as ScheduledFunctionMethod)) {
      return status(400, { error: "method must be GET or POST" });
    }

    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });

    const schedules = readSchedules(project.config);
    const target = schedules.find((s) => s.id === params.scheduleId);
    if (!target) return status(404, { error: "Scheduled function not found" });

    const updatedSchedule: ScheduledFunctionConfig = {
      ...target,
      name: input.name !== undefined ? input.name.trim().slice(0, 120) : target.name,
      cron: input.cron !== undefined ? input.cron.trim() : target.cron,
      method: input.method !== undefined ? (input.method as ScheduledFunctionMethod) : target.method,
      body: input.body !== undefined ? input.body : target.body,
      headers: input.headers !== undefined ? input.headers : target.headers,
      enabled: input.enabled !== undefined ? !!input.enabled : target.enabled,
      updated_at: new Date().toISOString(),
    };

    const next = schedules.map((s) => (s.id === target.id ? updatedSchedule : s));
    const updated = await projectRepository.updateConfig(
      params.ref,
      mergeProjectConfig(project.config, { scheduled_functions: next }),
    );
    if (!updated) return status(404, { error: "Project not found" });

    scheduledFunctionWorker.reload();
    return { updated: true, project_ref: params.ref, schedule: publicSafeSchedule(updatedSchedule) };
  }, {
    body: t.Object({
      name: t.Optional(t.String()),
      cron: t.Optional(t.String()),
      method: t.Optional(t.Union([t.Literal("GET"), t.Literal("POST")])),
      body: t.Optional(t.Record(t.String(), t.Unknown())),
      headers: t.Optional(t.Record(t.String(), t.String())),
      enabled: t.Optional(t.Boolean()),
    }),
    detail: { tags: ["scheduled-functions"], summary: "Update a scheduled function" },
  })
  .delete("/:scheduleId", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });

    const schedules = readSchedules(project.config);
    const next = schedules.filter((s) => s.id !== params.scheduleId);
    if (next.length === schedules.length) return status(404, { error: "Scheduled function not found" });

    const updated = await projectRepository.updateConfig(
      params.ref,
      mergeProjectConfig(project.config, { scheduled_functions: next }),
    );
    if (!updated) return status(404, { error: "Project not found" });

    scheduledFunctionWorker.reload();
    return { deleted: true, project_ref: params.ref, schedule_id: params.scheduleId };
  }, {
    detail: { tags: ["scheduled-functions"], summary: "Delete a scheduled function" },
  })
  .post("/:scheduleId/trigger", async ({ params }) => {
    const project = await projectRepository.findByRef(params.ref);
    if (!project) return status(404, { error: "Project not found" });

    const schedules = readSchedules(project.config);
    const target = schedules.find((s) => s.id === params.scheduleId);
    if (!target) return status(404, { error: "Scheduled function not found" });

    const result = await scheduledFunctionWorker.triggerOnce(params.ref, target);
    if (!result.ok) return status(502, { error: result.error });
    return { triggered: true, project_ref: params.ref, schedule_id: params.scheduleId, status: result.status };
  }, {
    detail: { tags: ["scheduled-functions"], summary: "Manually trigger a scheduled function" },
  });
