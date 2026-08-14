import type { SupabaseClient } from '@supabase/supabase-js'

export type ParityModule = 'protocol' | 'rest' | 'rpc' | 'auth' | 'storage' | 'rls'

export interface ParityObservation {
  ok: boolean
  status?: number
  code?: string
  data?: unknown
}

export interface ParityContext {
  anon: SupabaseClient
  service: SupabaseClient
  runId: string
  request(path: string, init?: RequestInit): Promise<Response>
}

export interface ParityScenario {
  name: string
  module: ParityModule
  run(context: ParityContext): Promise<ParityObservation>
  expect(observation: ParityObservation): boolean
}

export function sdkObservation(response: {
  data?: unknown
  error?: { code?: string; status?: number; statusCode?: number | string } | null
}): ParityObservation {
  const numericStatus = Number(response.error?.status ?? response.error?.statusCode)
  return {
    ok: !response.error,
    ...(Number.isFinite(numericStatus) ? { status: numericStatus } : {}),
    ...(response.error?.code ? { code: response.error.code } : {}),
    ...(response.data !== undefined ? { data: stableValue(response.data) } : {}),
  }
}

export function stableValue(input: unknown): unknown {
  if (input === null || input === undefined) return input
  if (typeof input === 'string') {
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input)) return '<uuid>'
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(input)) return '<timestamp>'
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(input)) return '<jwt>'
    return input
  }
  if (Array.isArray(input)) return input.map(stableValue)
  if (input instanceof Blob) return { size: input.size, type: input.type }
  if (typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    )
  }
  return input
}
