import type { LoadedFunction } from './handler.js'

export type RuntimeMode = 'development' | 'strict'

export function runtimeMode(value: unknown): RuntimeMode {
  if (value === undefined) return 'development'
  if (value !== 'development' && value !== 'strict') throw new Error('Lite runtime mode must be development or strict')
  return value
}

export function strictFunction(entry: LoadedFunction): LoadedFunction {
  const limits = {
    timeoutMs: 900_000,
    maxRequestBodyBytes: 30 * 1024 * 1024,
    maxResponseBodyBytes: 30 * 1024 * 1024,
    waitUntilTimeoutMs: 300_000,
    ...entry.limits,
  }
  for (const [name, value] of Object.entries(limits)) {
    const maximum = name.includes('Body') ? 30 * 1024 * 1024 : name === 'waitUntilTimeoutMs' ? 300_000 : 900_000
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`invalid strict function limit: ${name}`)
    }
  }
  if (entry.framework !== undefined && !['fetch', 'elysia', 'hono'].includes(entry.framework)) {
    throw new Error('invalid strict function framework')
  }
  return {
    ...entry, limits,
    capabilities: { background: false, ...entry.capabilities },
  }
}
