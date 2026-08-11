import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type } from "@sinclair/typebox";
import { projectRefPathSegment } from "../project-ref";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import {
    releaseControlFailure,
    releaseControlMutationFailure,
    releaseControlSuccess,
    type ReleaseControlToolResponse,
} from "./release-control-response";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>,
    ) => void;
};

type ScheduledFunctionAction = "list" | "get" | "create" | "update" | "delete";

interface ScheduledFunctionToolsOptions {
    readOnly?: boolean;
}

interface SafeScheduledFunction {
    id: string;
    name: string;
    slug: string;
    cron: string;
    method: "GET" | "POST";
    enabled: boolean;
    body_empty: boolean;
    header_names: string[];
    created_at: string;
    updated_at: string;
}

type ScheduleMutationExpectation = {
    action: "create";
    ref: string;
    requestId: string;
    expectedFields: Record<string, unknown>;
} | {
    action: "update";
    ref: string;
    scheduleId: string;
    requestId: string;
    expectedUpdatedAt: string;
    expectedFields: Record<string, unknown>;
};

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const FORBIDDEN_HEADER_NAMES = new Set([
    "apikey",
    "authorization",
    "connection",
    "content-length",
    "forwarded",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
    "x-project-ref",
]);
const SCHEDULE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CRON_PART_PATTERN = /^(\*|([0-9]+)(?:-([0-9]+))?)(?:\/([0-9]+))?$/;
const CRON_FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
const MAX_CRON_EXPRESSION_LENGTH = 256;
const MAX_BODY_FILE_BYTES = 1_048_576;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const MAX_SCHEDULE_NAME_LENGTH = 120;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const headerEnvironmentRecord = Type.Record(Type.String(), Type.String());
const ACTION_ARGUMENTS: Record<ScheduledFunctionAction, ReadonlySet<string>> = {
    list: new Set(["action", "ref"]),
    get: new Set(["action", "ref", "schedule_id"]),
    create: new Set(["action", "ref", "name", "slug", "cron", "method", "body_file", "header_env"]),
    update: new Set(["action", "ref", "schedule_id", "expected_updated_at", "name", "cron", "method", "enabled", "body_file", "header_env"]),
    delete: new Set(["action", "ref", "schedule_id", "expected_updated_at"]),
};

function parseHeaderEnvironment(input: string | Record<string, string>): unknown {
    if (typeof input !== "string") return input;
    try {
        return JSON.parse(input);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error("Invalid header_env JSON object");
    }
}

const headerEnvironmentSchema = Type.Optional(decodedSchema(
    Type.Union([Type.String(), headerEnvironmentRecord]),
    headerEnvironmentRecord,
    parseHeaderEnvironment,
));

function objectRecord(candidate: unknown): Record<string, unknown> | null {
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function boundedCronInteger(input: string, minimum: number, maximum: number): boolean {
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function validCronPart(part: string, minimum: number, maximum: number): boolean {
    const match = CRON_PART_PATTERN.exec(part);
    if (!match) return false;
    const start = match[1] === "*" ? minimum : Number(match[2]);
    const end = match[1] === "*" ? maximum : Number(match[3] ?? match[2]);
    const step = Number(match[4] ?? "1");
    return boundedCronInteger(String(start), minimum, maximum)
        && boundedCronInteger(String(end), minimum, maximum) && start <= end
        && boundedCronInteger(String(step), 1, maximum - minimum + 1);
}

function validCronField(field: string, minimum: number, maximum: number): boolean {
    const parts = field.split(",");
    return parts.length <= maximum - minimum + 1
        && parts.every((part) => part.length > 0 && validCronPart(part, minimum, maximum));
}

function validScheduledFunctionCron(expression: string): boolean {
    if (!expression || expression.length > MAX_CRON_EXPRESSION_LENGTH) return false;
    const fields = expression.trim().split(/\s+/);
    return fields.length === CRON_FIELD_BOUNDS.length
        && fields.every((field, index) => {
            const [minimum, maximum] = CRON_FIELD_BOUNDS[index];
            return validCronField(field, minimum, maximum);
        });
}

function readScheduleBodyFile(bodyPathInput: string): Record<string, unknown> {
    if (!bodyPathInput.trim()) throw new Error("'body_file' must be a path");
    const bodyPath = resolve(bodyPathInput);
    const bodyStat = statSync(bodyPath);
    if (!bodyStat.isFile() || bodyStat.size > MAX_BODY_FILE_BYTES) {
        throw new Error("Scheduled Function body file must be a regular file no larger than 1 MiB");
    }
    let payload: unknown;
    try {
        payload = JSON.parse(readFileSync(bodyPath, "utf8"));
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error("Scheduled Function body file must contain exact JSON");
    }
    const body = objectRecord(payload);
    if (!body) throw new Error("Scheduled Function body file must contain a JSON object");
    return body;
}

function scheduleBody(bodyFile: unknown): Record<string, unknown> | undefined {
    if (bodyFile === undefined) return undefined;
    if (typeof bodyFile !== "string") throw new Error("'body_file' must be a path");
    return readScheduleBodyFile(bodyFile);
}

function resolvedHeaderEntry(
    headerName: string,
    environmentName: unknown,
    environment: NodeJS.ProcessEnv,
): [string, string] {
    const normalizedName = headerName.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(headerName) || forbiddenHeaderName(normalizedName)
        || typeof environmentName !== "string" || !ENVIRONMENT_NAME_PATTERN.test(environmentName)) {
        throw new Error("SCHEDULE_HEADER_MAPPING_INVALID");
    }
    const headerValue = environment[environmentName];
    if (!headerValue) throw new Error("SCHEDULE_HEADER_ENV_MISSING");
    if (!headerValueIsStable(normalizedName, headerValue)) throw new Error("SCHEDULE_HEADER_INVALID");
    return [normalizedName, headerValue];
}

function forbiddenHeaderName(name: string): boolean {
    return FORBIDDEN_HEADER_NAMES.has(name) || name.startsWith("x-forwarded-");
}

function headerValueIsStable(name: string, value: string): boolean {
    if (!value || value.length > MAX_HEADER_VALUE_LENGTH) return false;
    try {
        const headers = new Headers();
        headers.set(name, value);
        return headers.get(name) === value;
    } catch {
        return false;
    }
}

function scheduleHeaders(
    mapping: unknown,
    environment: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
    if (mapping === undefined) return undefined;
    const headerEnvironment = objectRecord(mapping);
    if (!headerEnvironment) throw new Error("'header_env' must be a JSON object");
    const entries = Object.entries(headerEnvironment).map(
        ([headerName, environmentName]) => resolvedHeaderEntry(headerName, environmentName, environment),
    );
    const names = entries.map(([name]) => name);
    if (entries.length > MAX_HEADER_COUNT || new Set(names).size !== names.length) {
        throw new Error("SCHEDULE_HEADER_INVALID");
    }
    return Object.fromEntries(entries);
}

function validSafeSchedule(schedule: Record<string, unknown>): boolean {
    return validScheduleIdentity(schedule)
        && validScheduleDefinition(schedule)
        && validScheduleMetadata(schedule);
}

function validScheduleIdentity(schedule: Record<string, unknown>): boolean {
    return typeof schedule.id === "string" && SCHEDULE_ID_PATTERN.test(schedule.id)
        && typeof schedule.name === "string" && schedule.name.trim().length > 0
        && schedule.name.length <= MAX_SCHEDULE_NAME_LENGTH
        && typeof schedule.slug === "string" && SAFE_SLUG_PATTERN.test(schedule.slug);
}

function validScheduleDefinition(schedule: Record<string, unknown>): boolean {
    return typeof schedule.cron === "string" && validScheduledFunctionCron(schedule.cron)
        && (schedule.method === "GET" || schedule.method === "POST")
        && typeof schedule.enabled === "boolean";
}

function validScheduleMetadata(schedule: Record<string, unknown>): boolean {
    return typeof schedule.created_at === "string" && isCanonicalTimestamp(schedule.updated_at);
}

function isCanonicalTimestamp(candidate: unknown): candidate is string {
    if (typeof candidate !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(candidate)) return false;
    const milliseconds = Date.parse(candidate);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate;
}

function safeSchedulePayload(
    schedule: Record<string, unknown>,
): Pick<SafeScheduledFunction, "body_empty" | "header_names"> | null {
    const headerNames = safeHeaderNames(schedule.header_names);
    if (typeof schedule.body_empty !== "boolean" || !headerNames) return null;
    return { body_empty: schedule.body_empty, header_names: headerNames };
}

function safeHeaderNames(candidate: unknown): string[] | null {
    if (!Array.isArray(candidate) || candidate.length > MAX_HEADER_COUNT) return null;
    const names = candidate.map((name) => typeof name === "string" ? name.toLowerCase() : "");
    const valid = candidate.every((name, index) => typeof name === "string"
        && HEADER_NAME_PATTERN.test(name) && !forbiddenHeaderName(names[index]));
    return valid && new Set(names).size === names.length ? names.sort() : null;
}

function safeSchedule(candidate: unknown): SafeScheduledFunction | null {
    const schedule = objectRecord(candidate);
    if (!schedule || !validSafeSchedule(schedule)) return null;
    const safePayload = safeSchedulePayload(schedule);
    if (!safePayload) return null;
    return {
        id: schedule.id as string,
        name: schedule.name as string,
        slug: schedule.slug as string,
        cron: schedule.cron as string,
        method: schedule.method as "GET" | "POST",
        enabled: schedule.enabled as boolean,
        ...safePayload,
        created_at: schedule.created_at as string,
        updated_at: schedule.updated_at as string,
    };
}

function requiredText(args: Record<string, unknown>, name: string, action: string): string {
    const candidate = args[name];
    if (typeof candidate !== "string" || !candidate.trim()) {
        throw new Error(`'${name}' is required for '${action}'`);
    }
    return candidate.trim();
}

function assertActionArguments(action: ScheduledFunctionAction, args: Record<string, unknown>): void {
    const unsupported = Object.keys(args).filter((name) => !ACTION_ARGUMENTS[action].has(name));
    if (unsupported.length > 0) {
        throw new Error(`'${unsupported[0]}' is not supported for '${action}'`);
    }
}

function schedulePath(ref: string, scheduleId?: string): string {
    const projectRefSegment = projectRefPathSegment(ref, "Scheduled Functions");
    if (scheduleId !== undefined && !SCHEDULE_ID_PATTERN.test(scheduleId)) {
        throw new Error("'schedule_id' is invalid");
    }
    const root = `/v1/projects/${projectRefSegment}/scheduled-functions`;
    return scheduleId ? `${root}/${encodeURIComponent(scheduleId)}` : root;
}

function scheduleFailure(operation: string, response: HttpResult<unknown>): ReleaseControlToolResponse {
    return releaseControlFailure(operation, "HTTP_ERROR", response.transportError ? null : response.status);
}

function listResponse(ref: string, response: HttpResult<unknown>): ReleaseControlToolResponse {
    const operation = "scheduled_functions.list";
    if (!response.ok) return scheduleFailure(operation, response);
    const payload = objectRecord(response.data);
    const rawSchedules = payload?.schedules;
    const schedules = Array.isArray(rawSchedules) ? rawSchedules.map(safeSchedule) : null;
    if (payload?.project_ref !== ref || !schedules || schedules.some((schedule) => !schedule)) {
        return releaseControlFailure(operation, "INVALID_RESPONSE", null);
    }
    const ids = schedules.map((schedule) => schedule!.id);
    if (new Set(ids).size !== ids.length) return releaseControlFailure(operation, "INVALID_RESPONSE", null);
    return releaseControlSuccess(operation, { project_ref: ref, schedules });
}

function getResponse(
    ref: string,
    scheduleId: string,
    response: HttpResult<unknown>,
): ReleaseControlToolResponse {
    const operation = "scheduled_functions.get";
    if (!response.ok) return scheduleFailure(operation, response);
    const payload = objectRecord(response.data);
    const schedule = safeSchedule(payload?.schedule);
    if (payload?.project_ref !== ref || !schedule || schedule.id !== scheduleId) {
        return releaseControlFailure(operation, "INVALID_RESPONSE", null);
    }
    return releaseControlSuccess(operation, { project_ref: ref, schedule });
}

function mutationResponse(
    expectation: ScheduleMutationExpectation,
    response: HttpResult<unknown>,
): ReleaseControlToolResponse {
    const { action, ref, requestId, expectedFields } = expectation;
    const scheduleId = action === "update" ? expectation.scheduleId : undefined;
    const operation = `scheduled_functions.${action}`;
    if (!response.ok) return releaseControlMutationFailure(operation, response);
    const payload = objectRecord(response.data);
    const schedule = safeSchedule(payload?.schedule);
    const confirmsRequest = schedule && Object.entries(expectedFields).every(
        ([field, expected]) => isDeepStrictEqual(schedule[field as keyof SafeScheduledFunction], expected),
    );
    const confirmsRevision = action === "create"
        || (payload?.previous_updated_at === expectation.expectedUpdatedAt
            && schedule !== null && schedule.updated_at > expectation.expectedUpdatedAt);
    if (payload?.project_ref !== ref || payload.request_id !== requestId
        || payload?.[action === "create" ? "created" : "updated"] !== true
        || !schedule || !confirmsRequest || !confirmsRevision
        || (scheduleId !== undefined && schedule.id !== scheduleId)) {
        return releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.status);
    }
    return releaseControlSuccess(operation, {
        project_ref: ref,
        request_id: requestId,
        ...(action === "update" ? { previous_updated_at: expectation.expectedUpdatedAt } : {}),
        schedule,
    });
}

function deleteResponse(
    ref: string,
    scheduleId: string,
    expectedUpdatedAt: string,
    response: HttpResult<unknown>,
): ReleaseControlToolResponse {
    const operation = "scheduled_functions.delete";
    if (!response.ok) return releaseControlMutationFailure(operation, response);
    const payload = objectRecord(response.data);
    if (payload?.deleted !== true || payload.project_ref !== ref || payload.schedule_id !== scheduleId
        || payload.deleted_updated_at !== expectedUpdatedAt) {
        return releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.status);
    }
    return releaseControlSuccess(operation, {
        project_ref: ref,
        schedule_id: scheduleId,
        deleted_updated_at: expectedUpdatedAt,
        deleted: true,
    });
}

function readOnlyResult(): ReleaseControlToolResponse {
    return {
        isError: true,
        content: [{ type: "text", text: "⚠️ Scheduled Function write blocked in read-only mode." }],
    };
}

function createRequest(
    args: Record<string, unknown>,
    environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
    return {
        request_id: randomUUID(),
        name: requiredName(args, "create"),
        slug: requiredSlug(args, "create"),
        cron: requiredCron(args, "create"),
        method: requiredText(args, "method", "create"),
        body: scheduleBody(args.body_file) ?? {},
        headers: scheduleHeaders(args.header_env, environment) ?? {},
    };
}

function safeMutationFields(request: Record<string, unknown>): Record<string, unknown> {
    const safeFields = Object.fromEntries(
        ["name", "slug", "cron", "method", "enabled"]
            .filter((field) => request[field] !== undefined)
            .map((field) => [field, request[field]]),
    );
    if (request.body !== undefined) {
        safeFields.body_empty = Object.keys(request.body as Record<string, unknown>).length === 0;
    }
    if (request.headers !== undefined) {
        safeFields.header_names = Object.keys(request.headers as Record<string, string>).sort();
    }
    return safeFields;
}

function requiredName(args: Record<string, unknown>, action: string): string {
    const name = requiredText(args, "name", action);
    if (name.length > MAX_SCHEDULE_NAME_LENGTH) throw new Error(`'name' is too long for '${action}'`);
    return name;
}

function requiredSlug(args: Record<string, unknown>, action: string): string {
    const slug = requiredText(args, "slug", action);
    if (!SAFE_SLUG_PATTERN.test(slug)) throw new Error(`'slug' is invalid for '${action}'`);
    return slug;
}

function requiredCron(args: Record<string, unknown>, action: string): string {
    const cron = requiredText(args, "cron", action);
    if (!validScheduledFunctionCron(cron)) throw new Error(`'cron' is invalid for '${action}'`);
    return cron;
}

function requiredExpectedUpdatedAt(args: Record<string, unknown>, action: "update" | "delete"): string {
    const candidate = args.expected_updated_at;
    if (!isCanonicalTimestamp(candidate)) {
        throw new Error(`'expected_updated_at' must be a canonical UTC timestamp for '${action}'`);
    }
    return candidate;
}

function updateRequest(
    args: Record<string, unknown>,
    environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
    const expectedUpdatedAt = requiredExpectedUpdatedAt(args, "update");
    const body = scheduleBody(args.body_file);
    const headers = scheduleHeaders(args.header_env, environment);
    const cron = args.cron === undefined ? undefined : requiredCron(args, "update");
    const name = args.name === undefined ? undefined : requiredName(args, "update");
    const mutationFields = Object.fromEntries([
        ["name", name], ["cron", cron], ["method", args.method],
        ["enabled", args.enabled], ["body", body], ["headers", headers],
    ].filter((entry) => entry[1] !== undefined));
    if (Object.keys(mutationFields).length === 0) {
        throw new Error("Scheduled Function update requires at least one field");
    }
    return {
        request_id: randomUUID(),
        expected_updated_at: expectedUpdatedAt,
        ...mutationFields,
    };
}

function deletePath(schedulePathname: string, expectedUpdatedAt: string): string {
    return `${schedulePathname}?expected_updated_at=${encodeURIComponent(expectedUpdatedAt)}`;
}

async function executeScheduleAction(
    http: HttpTransport,
    environment: NodeJS.ProcessEnv,
    args: Record<string, unknown>,
    readOnly = false,
): Promise<ReleaseControlToolResponse> {
    const action = args.action as ScheduledFunctionAction;
    if (readOnly && action !== "list" && action !== "get") return readOnlyResult();
    assertActionArguments(action, args);
    const ref = requiredText(args, "ref", action);
    if (action === "list") return listResponse(ref, await http.get(schedulePath(ref)));
    if (action === "create") {
        const request = createRequest(args, environment);
        const requestId = request.request_id as string;
        return mutationResponse({ action, ref, requestId, expectedFields: safeMutationFields(request) },
            await http.post(schedulePath(ref), request));
    }
    const scheduleId = requiredText(args, "schedule_id", action);
    const targetPath = schedulePath(ref, scheduleId);
    if (action === "get") return getResponse(ref, scheduleId, await http.get(targetPath));
    if (action === "update") {
        const request = updateRequest(args, environment);
        const requestId = request.request_id as string;
        const expectedUpdatedAt = request.expected_updated_at as string;
        return mutationResponse({
            action,
            ref,
            scheduleId,
            requestId,
            expectedUpdatedAt,
            expectedFields: safeMutationFields(request),
        }, await http.patch(targetPath, request));
    }
    const expectedUpdatedAt = requiredExpectedUpdatedAt(args, "delete");
    return deleteResponse(ref, scheduleId, expectedUpdatedAt,
        await http.delete(deletePath(targetPath, expectedUpdatedAt)));
}

export function registerScheduledFunctionTools(
    server: ToolServer,
    http: HttpTransport,
    environment: NodeJS.ProcessEnv = process.env,
    options: ScheduledFunctionToolsOptions = {},
): void {
    server.tool("scheduled_functions", SCHEDULE_TOOL_DESCRIPTION, SCHEDULE_TOOL_SCHEMA,
        (args) => executeScheduleAction(http, environment, args, options.readOnly));
}

const SCHEDULE_TOOL_DESCRIPTION = "Scheduled Edge Function lifecycle. Actions: list, get, create, update, delete";
const SCHEDULE_TOOL_SCHEMA: ToolSchema = {
    action: withDescription(stringEnum(["list", "get", "create", "update", "delete"]), "Action"),
    ref: withDescription(Type.String(), "Project ref"),
    schedule_id: optional(Type.String(), "[get/update/delete] Schedule ID"),
    expected_updated_at: optional(Type.String(), "[update/delete] Canonical updated_at from list"),
    name: optional(Type.String(), "[create/update] Display name"),
    slug: optional(Type.String(), "[create] Edge Function slug"),
    cron: optional(Type.String(), "[create/update] Five-field cron expression"),
    method: optional(stringEnum(["GET", "POST"]), "[create/update] HTTP method"),
    enabled: optional(Type.Boolean(), "[update] Enabled state"),
    body_file: optional(Type.String(), "[create/update] Local JSON object file; content is never printed"),
    header_env: withDescription(
        headerEnvironmentSchema,
        "[create/update] JSON map of HTTP header names to environment variable names",
    ),
};
