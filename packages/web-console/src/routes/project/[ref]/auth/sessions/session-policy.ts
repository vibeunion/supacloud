import {
  authApiResponseMessage,
  unwrapAuthApiObject,
  type JsonObject,
} from "../../auth-api-response";

export type BooleanChoice = "" | "true" | "false";
export type DurationMode = "unavailable" | "disabled" | "enabled";
export type DependentStatus = "applied" | "failed" | "unknown";
export type { JsonObject } from "../../auth-api-response";

export type SessionDraft = {
  jwtExpiry: string;
  rotationEnabled: BooleanChoice;
  reuseInterval: string;
  inactivityMode: DurationMode;
  inactivityTimeout: string;
  singlePerUser: BooleanChoice;
  timeboxMode: DurationMode;
  timebox: string;
};

export type AuthApplyWarning = {
  code: string;
  message: string;
  runtimeApplied: boolean | null;
  dependentsApplied: boolean | null;
  dependentStatus: DependentStatus | null;
  failedDependents: string[];
  authorityProjectRef: string | null;
  readBackError?: string;
};

export type AuthManagedBoundary = {
  message: string;
  authorityProjectRef: string;
  ownerManagementPath: string | null;
};

export type SessionSaveDirective =
  | { kind: "applied"; requiresReadBack: true }
  | { kind: "partial"; requiresReadBack: true; warning: AuthApplyWarning }
  | { kind: "failed"; requiresReadBack: false; message: string };

type ConfigField = { found: boolean; rawValue: unknown };
type ParsedDuration = { mode: DurationMode; seconds: string };

const MAX_SESSION_DURATION_SECONDS = 9_223_372_036;
const DURATION_TOKEN = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g;
const DURATION_UNIT_SECONDS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  "µs": 1e-6,
  "μs": 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};
const NUMBER_RESPONSE_FIELDS = [
  "jwt_expiry",
  "jwt_exp",
  "security_refresh_token_reuse_interval",
  "security_refresh_token_rotation_reuse_interval",
] as const;
const BOOLEAN_RESPONSE_FIELDS = [
  "refresh_token_rotation_enabled",
  "security_refresh_token_rotation_enabled",
  "sessions_single_per_user",
] as const;
const DURATION_RESPONSE_FIELDS = [
  "sessions_inactivity_timeout",
  "sessions_timebox",
] as const;
const SESSION_RESPONSE_FIELDS = [
  ...NUMBER_RESPONSE_FIELDS,
  ...BOOLEAN_RESPONSE_FIELDS,
  ...DURATION_RESPONSE_FIELDS,
] as const;
const NUMBER_RESPONSE_FIELD_SET = new Set<string>(NUMBER_RESPONSE_FIELDS);
const BOOLEAN_RESPONSE_FIELD_SET = new Set<string>(BOOLEAN_RESPONSE_FIELDS);
const REQUIRED_RESPONSE_FIELD_GROUPS = [
  ["jwt_expiry", "jwt_exp"],
  ["refresh_token_rotation_enabled", "security_refresh_token_rotation_enabled"],
] as const;

export class SessionPolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPolicyInputError";
  }
}

export class SessionPolicyResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPolicyResponseError";
  }
}

export function emptySessionDraft(): SessionDraft {
  return {
    jwtExpiry: "",
    rotationEnabled: "",
    reuseInterval: "",
    inactivityMode: "unavailable",
    inactivityTimeout: "",
    singlePerUser: "",
    timeboxMode: "unavailable",
    timebox: "",
  };
}

export function cloneSessionDraft(draft: SessionDraft): SessionDraft {
  return { ...draft };
}

function readField(source: JsonObject, names: string[]): ConfigField {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(source, name)) {
      return { found: true, rawValue: source[name] };
    }
  }
  return { found: false, rawValue: undefined };
}

function hasOwn(source: JsonObject, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, field);
}

function readBooleanChoice(field: ConfigField): BooleanChoice {
  if (!field.found || field.rawValue === null || field.rawValue === undefined) return "";
  if (field.rawValue === true || field.rawValue === "true" || field.rawValue === 1) return "true";
  if (field.rawValue === false || field.rawValue === "false" || field.rawValue === 0) return "false";
  return "";
}

function readNumber(field: ConfigField): string {
  if (!field.found || field.rawValue === null || field.rawValue === undefined || field.rawValue === "") return "";
  if (typeof field.rawValue !== "number" && typeof field.rawValue !== "string") return "";
  const parsedNumber = Number(field.rawValue);
  return Number.isFinite(parsedNumber) ? String(parsedNumber) : "";
}

function parseTokenizedDuration(duration: string): number | null {
  let cursor = 0;
  let totalSeconds = 0;
  let validSequence = true;
  DURATION_TOKEN.lastIndex = 0;
  for (let match = DURATION_TOKEN.exec(duration); match; match = DURATION_TOKEN.exec(duration)) {
    if (match.index !== cursor) {
      validSequence = false;
      break;
    }
    totalSeconds += Number(match[1]) * DURATION_UNIT_SECONDS[match[2]];
    cursor = DURATION_TOKEN.lastIndex;
  }
  DURATION_TOKEN.lastIndex = 0;
  return validSequence && cursor === duration.length && Number.isFinite(totalSeconds) ? totalSeconds : null;
}

function parseDurationSeconds(rawDuration: unknown): number | null {
  if (typeof rawDuration === "number") {
    return Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : null;
  }
  if (typeof rawDuration !== "string") return null;
  const duration = rawDuration.trim();
  if (!duration) return null;
  const numericDuration = Number(duration);
  if (Number.isFinite(numericDuration) && numericDuration >= 0) return numericDuration;
  return parseTokenizedDuration(duration);
}

function validNumberResponseValue(rawValue: unknown): boolean {
  if (typeof rawValue !== "number" && typeof rawValue !== "string") return false;
  if (typeof rawValue === "string" && !rawValue.trim()) return false;
  const parsedNumber = Number(rawValue);
  return Number.isFinite(parsedNumber) && parsedNumber >= 0;
}

function validBooleanResponseValue(rawValue: unknown): boolean {
  return rawValue === true
    || rawValue === false
    || rawValue === "true"
    || rawValue === "false"
    || rawValue === 1
    || rawValue === 0;
}

function validDurationResponseValue(rawValue: unknown): boolean {
  return rawValue === null || parseDurationSeconds(rawValue) !== null;
}

function parseDependentStatus(
  rawStatus: unknown,
  dependentsApplied: boolean | null,
  failedDependents: string[],
): DependentStatus | null {
  if (rawStatus === "applied" || rawStatus === "failed" || rawStatus === "unknown") return rawStatus;
  if (dependentsApplied === true) return "applied";
  return failedDependents.length > 0 ? "failed" : null;
}

function validateSessionConfigResponse(authConfig: JsonObject): void {
  const recognizedFields = SESSION_RESPONSE_FIELDS.filter((field) => hasOwn(authConfig, field));
  if (recognizedFields.length === 0) {
    throw new SessionPolicyResponseError("认证配置响应缺少可识别的会话策略字段");
  }
  for (const fieldGroup of REQUIRED_RESPONSE_FIELD_GROUPS) {
    if (!fieldGroup.some((field) => hasOwn(authConfig, field))) {
      throw new SessionPolicyResponseError(`认证配置响应缺少必要字段 ${fieldGroup.join("/")}`);
    }
  }

  for (const field of recognizedFields) {
    const rawValue = authConfig[field];
    const valid = NUMBER_RESPONSE_FIELD_SET.has(field)
      ? validNumberResponseValue(rawValue)
      : BOOLEAN_RESPONSE_FIELD_SET.has(field)
        ? validBooleanResponseValue(rawValue)
        : validDurationResponseValue(rawValue);
    if (!valid) throw new SessionPolicyResponseError(`认证配置响应字段 ${field} 的类型无效`);
  }
}

function readDuration(field: ConfigField): ParsedDuration {
  if (!field.found) return { mode: "unavailable", seconds: "" };
  if (field.rawValue === null || field.rawValue === undefined) return { mode: "disabled", seconds: "" };
  const parsedSeconds = parseDurationSeconds(field.rawValue);
  if (parsedSeconds === null) return { mode: "unavailable", seconds: "" };
  if (parsedSeconds === 0) return { mode: "disabled", seconds: "" };
  return { mode: "enabled", seconds: String(parsedSeconds) };
}

export function normalizeSessionConfig(payload: unknown): SessionDraft {
  const authConfig = unwrapAuthApiObject(payload);
  const inactivity = readDuration(readField(authConfig, ["sessions_inactivity_timeout"]));
  const timebox = readDuration(readField(authConfig, ["sessions_timebox"]));
  return {
    jwtExpiry: readNumber(readField(authConfig, ["jwt_expiry", "jwt_exp"])),
    rotationEnabled: readBooleanChoice(readField(authConfig, [
      "refresh_token_rotation_enabled",
      "security_refresh_token_rotation_enabled",
    ])),
    reuseInterval: readNumber(readField(authConfig, [
      "security_refresh_token_reuse_interval",
      "security_refresh_token_rotation_reuse_interval",
    ])),
    inactivityMode: inactivity.mode,
    inactivityTimeout: inactivity.seconds,
    singlePerUser: readBooleanChoice(readField(authConfig, ["sessions_single_per_user"])),
    timeboxMode: timebox.mode,
    timebox: timebox.seconds,
  };
}

export function parseSessionConfigResponse(payload: unknown): SessionDraft {
  const authConfig = unwrapAuthApiObject(payload);
  validateSessionConfigResponse(authConfig);
  return normalizeSessionConfig(authConfig);
}

function parseIntegerInput(input: string, label: string, minimum: number, maximum: number): number {
  const trimmedInput = input.trim();
  if (!trimmedInput) throw new SessionPolicyInputError(`${label} 不能为空`);
  if (!/^\d+$/.test(trimmedInput)) throw new SessionPolicyInputError(`${label} 必须是非负整数`);
  const parsedNumber = Number(trimmedInput);
  if (!Number.isSafeInteger(parsedNumber) || parsedNumber < minimum || parsedNumber > maximum) {
    throw new SessionPolicyInputError(`${label} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return parsedNumber;
}

function parseDurationInput(input: string, label: string): number {
  const trimmedInput = input.trim();
  if (!trimmedInput) throw new SessionPolicyInputError(`${label} 不能为空`);
  const parsedSeconds = Number(trimmedInput);
  if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0 || parsedSeconds > MAX_SESSION_DURATION_SECONDS) {
    throw new SessionPolicyInputError(`${label} 必须是大于 0 的秒数`);
  }
  return parsedSeconds;
}

function accessPolicyPatch(draft: SessionDraft, baseline: SessionDraft): JsonObject {
  const patch: JsonObject = {};
  if (draft.jwtExpiry !== baseline.jwtExpiry) {
    patch.jwt_expiry = draft.jwtExpiry.trim()
      ? parseIntegerInput(draft.jwtExpiry, "JWT 有效期", 0, 604_800)
      : null;
  }
  if (draft.rotationEnabled !== baseline.rotationEnabled) {
    patch.refresh_token_rotation_enabled = draft.rotationEnabled === "" ? null : draft.rotationEnabled === "true";
  }
  if (draft.reuseInterval !== baseline.reuseInterval) {
    patch.security_refresh_token_reuse_interval = draft.reuseInterval.trim()
      ? parseIntegerInput(draft.reuseInterval, "Refresh Token 重用窗口", 0, 2_147_483_647)
      : null;
  }
  return patch;
}

function sessionLimitPatch(draft: SessionDraft, baseline: SessionDraft): JsonObject {
  const patch: JsonObject = {};
  if (draft.inactivityMode !== baseline.inactivityMode || draft.inactivityTimeout !== baseline.inactivityTimeout) {
    patch.sessions_inactivity_timeout = draft.inactivityMode === "enabled"
      ? parseDurationInput(draft.inactivityTimeout, "非活动超时")
      : null;
  }
  if (draft.singlePerUser !== baseline.singlePerUser) {
    patch.sessions_single_per_user = draft.singlePerUser === "" ? null : draft.singlePerUser === "true";
  }
  if (draft.timeboxMode !== baseline.timeboxMode || draft.timebox !== baseline.timebox) {
    patch.sessions_timebox = draft.timeboxMode === "enabled"
      ? parseDurationInput(draft.timebox, "会话总时长")
      : null;
  }
  return patch;
}

export function buildSessionPolicyPatch(draft: SessionDraft, baseline: SessionDraft): JsonObject {
  return {
    ...accessPolicyPatch(draft, baseline),
    ...sessionLimitPatch(draft, baseline),
  };
}

export function formatSessionSeconds(rawSeconds: string): string {
  const seconds = Number(rawSeconds);
  if (!Number.isFinite(seconds)) return "不可用";
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

export function parsePersistedApplyWarning(payload: unknown): AuthApplyWarning | null {
  const responseBody = unwrapAuthApiObject(payload);
  if (responseBody.persisted !== true) return null;
  const dependentsApplied = typeof responseBody.dependents_applied === "boolean"
    ? responseBody.dependents_applied
    : null;
  const failedDependents = Array.isArray(responseBody.failed_dependents)
    ? responseBody.failed_dependents.map(String)
    : [];
  return {
    code: typeof responseBody.code === "string" ? responseBody.code : "AUTH_RUNTIME_APPLY_FAILED",
    message: authApiResponseMessage(responseBody, "认证配置已保存，但运行时未完成应用"),
    runtimeApplied: typeof responseBody.runtime_applied === "boolean" ? responseBody.runtime_applied : null,
    dependentsApplied,
    dependentStatus: parseDependentStatus(responseBody.dependent_status, dependentsApplied, failedDependents),
    failedDependents,
    authorityProjectRef: typeof responseBody.authority_project_ref === "string"
      ? responseBody.authority_project_ref
      : null,
  };
}

export function dependentStatusLabel(status: DependentStatus): string {
  if (status === "applied") return "已刷新";
  if (status === "failed") return "存在失败";
  return "状态未知";
}

export function parseAuthManagedBoundary(payload: unknown): AuthManagedBoundary | null {
  const responseBody = unwrapAuthApiObject(payload);
  if (responseBody.code !== "AUTH_RUNTIME_MANAGED_BY_OWNER") return null;
  if (typeof responseBody.authority_project_ref !== "string" || !responseBody.authority_project_ref.trim()) return null;
  return {
    message: authApiResponseMessage(responseBody, "该项目的认证配置由 SupAuth owner 项目管理"),
    authorityProjectRef: responseBody.authority_project_ref,
    ownerManagementPath: typeof responseBody.owner_management_path === "string"
      ? responseBody.owner_management_path
      : null,
  };
}

export function resolveSessionSaveDirective(response: {
  ok: boolean;
  status: number;
  payload: unknown;
}): SessionSaveDirective {
  if (response.ok) return { kind: "applied", requiresReadBack: true };
  const partialWarning = response.status === 503
    ? parsePersistedApplyWarning(response.payload)
    : null;
  if (partialWarning) {
    return { kind: "partial", requiresReadBack: true, warning: partialWarning };
  }
  return {
    kind: "failed",
    requiresReadBack: false,
    message: authApiResponseMessage(response.payload, `保存失败（${response.status}）`),
  };
}
