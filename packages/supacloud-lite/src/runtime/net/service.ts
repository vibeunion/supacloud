/**
 * In-process HTTP sender for the pg_net emulation - the execution half of the
 * net.* surface (the net.http_get/post/delete SQL functions live in
 * db/emulated.ts). It drains net.http_request_queue, performs each request with
 * fetch, and records the reply in net._http_response, mirroring pg_net's
 * background worker. No C extension, works on the wasm and native engines.
 */
import type { Database } from '../db/database.js'

/** Cap on the response body we buffer into net._http_response (bytes). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

/** Max redirect hops guardedFetch will follow, re-validating each target. */
const MAX_REDIRECTS = 5

/**
 * Reject requests to non-public destinations. A synchronous literal-host guard
 * (loopback / private / link-local / cloud-metadata) that also rejects
 * alternate numeric IP encodings which would slip past the literal checks but
 * still connect to a real address. No DNS lookup - a public hostname that
 * *resolves* to private space (DNS rebinding) is a residual this doesn't cover;
 * doing so would add a per-request lookup that can hang for 30s on an
 * unresolvable host. Returns an error string, or null when the URL is allowed.
 */
export function blockedNetTarget(rawUrl: string): string | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return 'invalid url'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `unsupported scheme: ${u.protocol}`
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return 'blocked host: localhost'
  if (isPrivateIp(host)) return `blocked host: ${host}`
  // Reject alternate numeric encodings of an IP that pass the literal checks but
  // still reach a real address - http://2130706433 and http://0x7f000001 both
  // connect to 127.0.0.1. A genuine DNS name contains a letter and is not
  // 0x-prefixed; dotted-IPv4 and IPv6 literals were already checked above.
  if (!host.includes(':') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && (host.startsWith('0x') || !/[a-z]/i.test(host))) {
    return `blocked host: ${host} (non-DNS address encoding)`
  }
  return null
}

function isPrivateIp(host: string): boolean {
  // IPv4
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 0 || a === 10 || a === 127) return true // this-host, private, loopback
    if (a === 169 && b === 254) return true // link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
    return false
  }
  // IPv6
  if (host === '::' || host === '::1') return true // unspecified / loopback
  if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true // link-local / ULA
  if (host.startsWith('::ffff:')) return isPrivateIp(host.slice(7)) // IPv4-mapped
  return false
}

/**
 * fetch with an SSRF guard that re-validates every redirect hop. Default fetch
 * follows redirects without re-checking, so a public URL could 3xx into private
 * space; this follows manually (capped at {@link MAX_REDIRECTS}) and runs
 * {@link blockedNetTarget} on each target. Throws with the block reason on a
 * rejected hop.
 */
export async function guardedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  let current = url
  for (let hop: number = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = blockedNetTarget(current)
    if (blocked) throw new Error(blocked)
    const res = await fetchImpl(current, { ...init, redirect: 'manual' })
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) return res
    current = new URL(location, current).toString()
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`)
}

interface RequestRow {
  id: number
  method: string
  url: string
  headers: Record<string, string> | string | null
  body: string | null
  timeout_milliseconds: number
}

/** Outcome of one drained request, passed to the optional `onDeliver` callback. */
export interface NetDelivery {
  /** net.http_request_queue row id */
  id: number
  method: string
  url: string
  /** response status; undefined when the request failed before a reply */
  status?: number
  /** true if the request aborted on its timeout */
  timedOut: boolean
  /** failure reason (network error, blocked target, etc.); undefined on success */
  error?: string
}

/**
 * Drains net.http_request_queue on an interval, performs each request, and
 * records the reply in net._http_response - the pg_net background worker,
 * in-process.
 */
export class NetService {
  private timer: ReturnType<typeof setInterval> | null = null
  private timerGeneration = 0
  /** The in-flight tick, tracked so stop() can drain it before db.close(). */
  private inFlight: Promise<void> | null = null

  constructor(
    private db: Database,
    private fetchImpl: typeof fetch = fetch,
    /** how often to drain the queue (ms) */
    private tickMs = 500,
    private onDeliver?: (d: NetDelivery) => void
  ) {}

  /** Begin draining the queue on the tick interval; no-op if already running. */
  start(): void {
    if (this.timer !== null) return
    const generation = ++this.timerGeneration
    let timer: ReturnType<typeof setInterval>
    timer = setInterval(() => {
      if (this.timer === timer && this.timerGeneration === generation) void this.tick()
    }, this.tickMs)
    this.timer = timer
    if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref()
  }

  /**
   * Stop the drain loop and wait for any in-flight tick to finish before the
   * caller closes the database - the single connection busy-loops if closed
   * while a query is still queued.
   */
  async stop(): Promise<void> {
    const timer = this.timer
    this.timer = null
    this.timerGeneration += 1
    if (timer !== null) clearInterval(timer)
    const inFlight = this.inFlight
    await inFlight?.catch(() => {})
  }

  /** Drain any queued requests once (also callable directly in tests). */
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const inFlight = Promise.resolve()
      .then(() => this.drainQueue())
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = null
      })
    this.inFlight = inFlight
    return inFlight
  }

  private async drainQueue(): Promise<void> {
    let rows: RequestRow[]
    try {
      rows = (
        await this.db.query<RequestRow>(
          `select id, method, url, headers, body, timeout_milliseconds from net.http_request_queue order by id limit 20`
        )
      ).rows
    } catch {
      return // net.* not present (e.g. the pg-mem subset engine)
    }
    for (const row of rows) {
      try {
        await this.deliver(row)
      } catch (e) {
        // A malformed row must never poison the loop or reject out of the
        // setInterval callback - dequeue it with the error recorded instead.
        const msg = e instanceof Error ? e.message : String(e)
        await this.record(row.id, null, null, null, null, false, msg)
        this.onDeliver?.({ id: row.id, method: row.method, url: row.url, timedOut: false, error: msg })
      }
    }
  }

  private async deliver(row: RequestRow): Promise<void> {
    const headers =
      typeof row.headers === 'string' ? (JSON.parse(row.headers) as Record<string, string>) : row.headers ?? {}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), row.timeout_milliseconds || 5000)

    let status: number | null = null
    let contentType: string | null = null
    let content: string | null = null
    let respHeaders: Record<string, string> | null = null
    let timedOut: boolean = false
    let errorMsg: string | null = null

    try {
      const hasBody = row.method !== 'GET' && row.method !== 'HEAD'
      // guardedFetch enforces the SSRF policy on the initial URL and every
      // redirect hop (a plain fetch would follow a 3xx into private space).
      const res = await guardedFetch(this.fetchImpl, row.url, {
        method: row.method,
        headers,
        body: hasBody ? row.body ?? undefined : undefined,
        signal: controller.signal,
      })
      status = res.status
      contentType = res.headers.get('content-type')
      respHeaders = Object.fromEntries(res.headers.entries())
      content = await readCapped(res, MAX_RESPONSE_BYTES)
    } catch (e) {
      if (controller.signal.aborted) timedOut = true
      errorMsg = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(timer)
    }

    await this.record(row.id, status, contentType, respHeaders, content, timedOut, errorMsg)
    this.onDeliver?.({
      id: row.id,
      method: row.method,
      url: row.url,
      status: status ?? undefined,
      timedOut,
      error: errorMsg ?? undefined,
    })
  }

  /** Record the response and remove the request from the queue (best-effort). */
  private async record(
    id: number,
    status: number | null,
    contentType: string | null,
    respHeaders: Record<string, string> | null,
    content: string | null,
    timedOut: boolean,
    errorMsg: string | null
  ): Promise<void> {
    try {
      await this.db.query(
        `insert into net._http_response (id, status_code, content_type, headers, content, timed_out, error_msg)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7) on conflict (id) do nothing`,
        [id, status, contentType, respHeaders ? JSON.stringify(respHeaders) : null, content, timedOut, errorMsg]
      )
      await this.db.query(`delete from net.http_request_queue where id = $1`, [id])
    } catch {
      // if recording fails, leave the row so the next tick retries
    }
  }
}

/** Read a response body as text, truncating at `maxBytes` to bound memory. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total: number = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  await reader.cancel().catch(() => {})
  let merged = new Uint8Array(Math.min(total, maxBytes))
  let offset: number = 0
  for (const c of chunks) {
    const take = Math.min(c.length, merged.length - offset)
    merged.set(c.subarray(0, take), offset)
    offset += take
    if (offset >= merged.length) break
  }
  return new TextDecoder().decode(merged)
}
