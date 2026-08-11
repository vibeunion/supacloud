export const SCHEDULE_HEADERS_INVALID = "SCHEDULE_HEADERS_INVALID";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 8_192;
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

function isForbiddenHeaderName(name: string): boolean {
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

export function normalizedScheduledFunctionHeaders(candidate: unknown): Record<string, string> | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const entries = Object.entries(candidate);
  if (entries.length > MAX_HEADER_COUNT) return null;
  const normalized: Array<[string, string]> = [];
  const names = new Set<string>();
  for (const [name, value] of entries) {
    const lowerName = name.toLowerCase();
    if (typeof value !== "string" || !HEADER_NAME_PATTERN.test(name)
      || isForbiddenHeaderName(lowerName) || names.has(lowerName)
      || !headerValueIsStable(lowerName, value)) return null;
    names.add(lowerName);
    normalized.push([lowerName, value]);
  }
  return Object.fromEntries(normalized);
}
