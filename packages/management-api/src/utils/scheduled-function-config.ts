import { isValidScheduledFunctionCron } from "./scheduled-function-cron";
import { normalizedScheduledFunctionHeaders } from "./scheduled-function-headers";
import { normalizeProjectConfig } from "./project-config";

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

export interface PublicScheduledFunction {
  id: string;
  name: string;
  slug: string;
  cron: string;
  method: ScheduledFunctionMethod;
  enabled: boolean;
  body_empty: boolean;
  header_names: string[];
  created_at: string;
  updated_at: string;
}

type PublicScheduleCandidate = ScheduledFunctionConfig & Partial<Pick<
  PublicScheduledFunction,
  "body_empty" | "header_names"
>>;

export const MAX_SCHEDULE_BODY_BYTES = 1_048_576;
export const MAX_SCHEDULE_NAME_LENGTH = 120;

const FUNCTION_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SCHEDULE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function objectRecord(candidate: unknown): Record<string, unknown> | null {
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function stringRecord(candidate: unknown): candidate is Record<string, string> {
  const record = objectRecord(candidate);
  return record !== null && Object.values(record).every((entry) => typeof entry === "string");
}

export function normalizedScheduledFunctionName(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const name = candidate.trim();
  return name.length > 0 && name.length <= MAX_SCHEDULE_NAME_LENGTH ? name : null;
}

export function normalizedScheduledFunctionSlug(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const slug = candidate.trim();
  return FUNCTION_SLUG_PATTERN.test(slug) ? slug : null;
}

export function scheduledFunctionBodyWithinLimit(candidate: unknown): boolean {
  if (candidate === undefined) return true;
  if (!objectRecord(candidate)) return false;
  try {
    const serialized = JSON.stringify(candidate);
    return new TextEncoder().encode(serialized).byteLength <= MAX_SCHEDULE_BODY_BYTES;
  } catch {
    return false;
  }
}

function validScheduleIdentity(schedule: Record<string, unknown>): boolean {
  return typeof schedule.id === "string" && SCHEDULE_ID_PATTERN.test(schedule.id)
    && normalizedScheduledFunctionName(schedule.name) !== null
    && normalizedScheduledFunctionSlug(schedule.slug) === schedule.slug;
}

function validScheduleDefinition(schedule: Record<string, unknown>): boolean {
  return typeof schedule.cron === "string" && isValidScheduledFunctionCron(schedule.cron)
    && (schedule.method === "GET" || schedule.method === "POST")
    && typeof schedule.enabled === "boolean";
}

function validSchedulePayload(schedule: Record<string, unknown>): boolean {
  return (schedule.body === undefined || objectRecord(schedule.body) !== null)
    && (schedule.headers === undefined || stringRecord(schedule.headers));
}

export function isScheduledFunctionConfig(candidate: unknown): candidate is ScheduledFunctionConfig {
  const schedule = objectRecord(candidate);
  return schedule !== null && validScheduleIdentity(schedule) && validScheduleDefinition(schedule)
    && validSchedulePayload(schedule)
    && typeof schedule.created_at === "string" && typeof schedule.updated_at === "string";
}

function publicBodyEmpty(schedule: PublicScheduleCandidate): boolean {
  if (Object.prototype.hasOwnProperty.call(schedule, "body")) {
    return Object.keys(objectRecord(schedule.body) ?? {}).length === 0;
  }
  return typeof schedule.body_empty === "boolean" ? schedule.body_empty : true;
}

function publicHeaderNames(schedule: PublicScheduleCandidate): string[] {
  if (Object.prototype.hasOwnProperty.call(schedule, "headers")) {
    return Object.keys(objectRecord(schedule.headers) ?? {}).map((name) => name.toLowerCase()).sort();
  }
  if (!Array.isArray(schedule.header_names)
    || !schedule.header_names.every((name) => typeof name === "string")) return [];
  const placeholderHeaders = Object.fromEntries(
    schedule.header_names.map((name) => [name, "redacted"]),
  );
  const normalizedHeaders = normalizedScheduledFunctionHeaders(placeholderHeaders);
  return normalizedHeaders ? Object.keys(normalizedHeaders).sort() : [];
}

export function publicScheduledFunction(schedule: PublicScheduleCandidate): PublicScheduledFunction {
  return {
    id: schedule.id,
    name: schedule.name,
    slug: schedule.slug,
    cron: schedule.cron,
    method: schedule.method,
    enabled: schedule.enabled,
    body_empty: publicBodyEmpty(schedule),
    header_names: publicHeaderNames(schedule),
    created_at: schedule.created_at,
    updated_at: schedule.updated_at,
  };
}

export function publicScheduledFunctionProjectConfig(candidate: unknown): Record<string, unknown> {
  const projectConfig = normalizeProjectConfig(candidate);
  if (!Object.prototype.hasOwnProperty.call(projectConfig, "scheduled_functions")) return projectConfig;
  const schedules = projectConfig.scheduled_functions;
  projectConfig.scheduled_functions = Array.isArray(schedules)
    ? schedules.filter(isScheduledFunctionConfig).map(publicScheduledFunction)
    : [];
  return projectConfig;
}
