export const protectionKeys = [
  "SECURITY_CAPTCHA_ENABLED",
  "SECURITY_IP_RESTRICTION_ENABLED",
  "PASSWORD_HIBC_ENABLE",
  "PASSWORD_STRENGTH_REQUIRE_COMPLEXITY",
  "SECURITY_LOCKOUT_ENABLED",
  "SECURITY_CORS_RESTRICTION_ENABLED",
] as const;
export type ProtectionKey = typeof protectionKeys[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const rateLimitKeys = [
  "RATE_LIMIT_SIGNUP", "RATE_LIMIT_SIGNIN", "RATE_LIMIT_TOKEN_REFRESH",
  "RATE_LIMIT_EMAIL_SENT", "RATE_LIMIT_EMAIL_OTP", "RATE_LIMIT_SMS_SENT",
  "RATE_LIMIT_SMS_OTP", "RATE_LIMIT_VERIFY", "RATE_LIMIT_ANONYMOUS_SIGN_IN",
] as const;
export type RateLimitKey = typeof rateLimitKeys[number];
export type RateLimitSettings = Partial<Record<RateLimitKey, number>>;

export function isRateLimitValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseRateLimitSettings(value: unknown): RateLimitSettings {
  if (!isObject(value)) throw new Error("Invalid authentication configuration");
  const result: RateLimitSettings = {};
  for (const key of rateLimitKeys) {
    if (!Object.hasOwn(value, key)) continue;
    const raw = value[key];
    const limit = typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : raw;
    if (!isRateLimitValue(limit)) throw new Error(`Invalid authentication setting: ${key}`);
    result[key] = limit;
  }
  return result;
}

export interface RateLimitEdit {
  envKey: RateLimitKey;
  value: number | undefined;
  original: number | undefined;
}

export function rateLimitPatch(edits: readonly RateLimitEdit[]): Partial<Record<RateLimitKey, string>> {
  const patch: Partial<Record<RateLimitKey, string>> = {};
  const seen = new Set<RateLimitKey>();
  for (const edit of edits) {
    if (seen.has(edit.envKey)) throw new Error("Duplicate rate limit setting");
    seen.add(edit.envKey);
    if (edit.value === edit.original) continue;
    if (!isRateLimitValue(edit.value)) throw new Error("Invalid rate limit value");
    patch[edit.envKey] = String(edit.value);
  }
  return patch;
}

export function parseRateLimitReceipt(
  value: unknown, expected: Readonly<Partial<Record<RateLimitKey, string>>>,
): void {
  const settings = parseRateLimitSettings(value);
  const submitted = parseRateLimitSettings(expected);
  if (Object.keys(submitted).length === 0
    || rateLimitKeys.some((key) => submitted[key] !== undefined && settings[key] !== submitted[key])) {
    throw new Error("Rate limit update response does not match the request");
  }
}

export function parseProtectionSettings(value: unknown): Partial<Record<ProtectionKey, boolean>> {
  if (!isObject(value)) throw new Error("Invalid authentication configuration");
  const result: Partial<Record<ProtectionKey, boolean>> = {};
  for (const key of protectionKeys) {
    if (!Object.hasOwn(value, key)) continue;
    const flag = value[key];
    if (flag !== true && flag !== false && flag !== "true" && flag !== "false") {
      throw new Error(`Invalid authentication setting: ${key}`);
    }
    result[key] = flag === true || flag === "true";
  }
  return result;
}

export interface StudioProviderSettings {
  enabled: boolean;
  client_id: string;
  redirect_uri: string;
  auth_scheme: string;
}

function optionalText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("Invalid provider setting");
  return value;
}

export function parseStudioProviders(value: unknown): Record<string, StudioProviderSettings> {
  if (!isObject(value) || !isObject(value.providers)) throw new Error("Invalid provider configuration");
  return Object.fromEntries(Object.entries(value.providers).map(([key, provider]) => {
    if (!isObject(provider) || typeof provider.enabled !== "boolean") {
      throw new Error("Invalid provider configuration");
    }
    return [key, {
      enabled: provider.enabled,
      client_id: optionalText(provider.client_id),
      redirect_uri: optionalText(provider.redirect_uri),
      auth_scheme: optionalText(provider.auth_scheme),
    }];
  }));
}

export function parseProviderReceipt(value: unknown, provider: string, enabled: boolean): { warning?: string } {
  if (!isObject(value) || (value.id ?? value.provider) !== provider || value.enabled !== enabled
    || (value.id !== undefined && value.id !== provider)
    || (value.provider !== undefined && value.provider !== provider)
    || (value.warning !== undefined && typeof value.warning !== "string")) {
    throw new Error("Invalid provider update response");
  }
  return value.warning === undefined ? {} : { warning: value.warning };
}

export const emailTemplateIds = ["confirmation", "invite", "magic_link", "recovery", "email_change", "reauthentication"] as const;
export type EmailTemplateId = typeof emailTemplateIds[number];
export interface AuthEmailTemplate {
  id: EmailTemplateId;
  subject: string;
  content: string;
}

export function parseEmailTemplates(value: unknown): AuthEmailTemplate[] {
  if (!isObject(value) || !isObject(value.templates)) throw new Error("Invalid email templates");
  const templates = value.templates;
  return emailTemplateIds.map((id) => {
    const template = templates[id];
    if (!isObject(template) || typeof template.subject !== "string" || typeof template.content !== "string") {
      throw new Error(`Invalid email template: ${id}`);
    }
    return { id, subject: template.subject, content: template.content };
  });
}

export function parseEmailTemplateReceipt(
  value: unknown, action: "save" | "reset", expected?: AuthEmailTemplate[],
): { warning?: string } {
  if (!isObject(value) || value[action === "save" ? "saved" : "reset"] !== true
    || (value.warning !== undefined && typeof value.warning !== "string")) {
    throw new Error("Invalid email template update response");
  }
  const templates = parseEmailTemplates(value);
  if (action === "save" && (!expected || templates.some((template) => {
    const submitted = expected.find((item) => item.id === template.id);
    return !submitted || template.subject !== submitted.subject || template.content !== submitted.content;
  }))) throw new Error("Email template update response does not match the request");
  return value.warning === undefined ? {} : { warning: value.warning };
}
