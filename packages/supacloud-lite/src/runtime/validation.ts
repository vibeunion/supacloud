/** Narrow untrusted boundary values before reading their properties. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorProperty(error: unknown, key: string): unknown {
  return isRecord(error) ? error[key] : undefined
}
