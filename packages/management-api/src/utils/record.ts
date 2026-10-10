export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
