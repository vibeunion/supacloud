/**
 * Agent handoff for one Lite project.
 * The payload is only the project URL, the anon key, and the next commands.
 * It never carries the service_role key.
 */

export interface LiteAgentHandoff {
  url: string
  anon_key: string
  next: string[]
}

export interface RlsCompletion {
  done: boolean
  rls_checks: 'ran' | 'skipped'
  skipped_is_done: false
  rls_disabled: string[]
  reason?: string
}

const SAFE_ARG = /^[A-Za-z0-9_./:@+=,-]+$/

/** Quote one command argument. Rejects newlines and NUL so the handoff stays one command list. */
export function shellArg(value: string): string {
  if (value.length === 0 || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('Invalid agent command argument')
  }
  if (SAFE_ARG.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function liteProjectUrl(input: { apiUrl?: string; host: string; port: number }): string {
  const explicit = input.apiUrl?.trim()
  if (explicit) {
    if (!/^https?:\/\//.test(explicit)) throw new Error('Agent handoff URL must be http(s)')
    return explicit
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('Agent handoff requires a concrete project port')
  }
  let host = input.host
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1'
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  return `http://${host}:${input.port}`
}

export function liteAgentNextCommands(projectDir: string, moduleFile = 'supabase/db/modules.ts'): string[] {
  const project = shellArg(projectDir)
  const module = shellArg(moduleFile)
  return [
    `supacloud-lite migrate --project-dir ${project}`,
    `supacloud-lite complete --project-dir ${project} --module-file ${module}`,
  ]
}

function jwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || !payload) throw new Error('Agent handoff anon key must be a project JWT')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    throw new Error('Agent handoff anon key payload is invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Agent handoff anon key payload is invalid')
  }
  return parsed as Record<string, unknown>
}

function assertAnonKey(token: string): void {
  const payload = jwtPayload(token)
  if (payload.role !== 'anon') throw new Error('Agent handoff refuses a non-anon project key')
  if (JSON.stringify(payload).includes('service_role')) {
    throw new Error('Agent handoff refuses a service_role key')
  }
}

export function buildLiteAgentHandoff(input: {
  url: string
  anonKey: string
  projectDir: string
  moduleFile?: string
}): LiteAgentHandoff {
  assertAnonKey(input.anonKey)
  const handoff: LiteAgentHandoff = {
    url: liteProjectUrl({ apiUrl: input.url, host: '127.0.0.1', port: 54321 }),
    anon_key: input.anonKey,
    next: liteAgentNextCommands(input.projectDir, input.moduleFile),
  }
  for (const command of handoff.next) {
    if (command.includes('--service-role') || command.includes('service_role')) {
      throw new Error('Agent handoff commands must not request the service_role key')
    }
  }
  if (!handoff.next.some((command) => command.startsWith('supacloud-lite migrate '))) {
    throw new Error('Agent handoff must include the migration ledger command')
  }
  if (!handoff.next.some((command) => command.startsWith('supacloud-lite complete '))) {
    throw new Error('Agent handoff must include the RLS completion command')
  }
  const keys = Object.keys(handoff)
  if (keys.length !== 3 || keys[0] !== 'url' || keys[1] !== 'anon_key' || keys[2] !== 'next') {
    throw new Error('Agent handoff may contain only url, anon_key, and next')
  }
  return handoff
}

export function serializeLiteAgentHandoff(handoff: LiteAgentHandoff): string {
  const payload = { url: handoff.url, anon_key: handoff.anon_key, next: [...handoff.next] }
  return `${JSON.stringify(payload)}\n`
}

/**
 * The existing module reconcile (`rls-disabled`) is the completion check.
 * A manifest with no owned table, or a check that did not execute, is skipped and not done.
 */
export function evaluateRlsCompletion(input: {
  executed: boolean
  ok: boolean
  ownedTableCount: number
  rlsDisabled: readonly string[]
}): RlsCompletion {
  const rlsDisabled = [...input.rlsDisabled]
  if (!input.executed || !Number.isInteger(input.ownedTableCount) || input.ownedTableCount < 1) {
    return {
      done: false,
      rls_checks: 'skipped',
      skipped_is_done: false,
      rls_disabled: rlsDisabled,
      reason: input.executed
        ? 'RLS reconcile did not cover an owned table. Declare tables in the database module manifest and rerun complete.'
        : 'RLS reconcile did not run',
    }
  }
  if (rlsDisabled.length > 0) {
    return {
      done: false,
      rls_checks: 'ran',
      skipped_is_done: false,
      rls_disabled: rlsDisabled,
      reason: `RLS is disabled on ${rlsDisabled.join(', ')}`,
    }
  }
  if (!input.ok) {
    return {
      done: false,
      rls_checks: 'ran',
      skipped_is_done: false,
      rls_disabled: rlsDisabled,
      reason: 'database module check reported error-level issues',
    }
  }
  return { done: true, rls_checks: 'ran', skipped_is_done: false, rls_disabled: rlsDisabled }
}
