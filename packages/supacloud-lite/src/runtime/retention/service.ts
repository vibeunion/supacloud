/**
 * In-process data-retention sweeper. Periodically purges expired or stale rows
 * that would otherwise accumulate forever: consumed/expired one-time tokens,
 * revoked and aged-out refresh tokens, expired MFA challenges and OAuth flow
 * state, and audit-log entries past the retention window.
 *
 * Supports GDPR data-minimization and keeps the auth tables from growing
 * unbounded. All windows are configurable; a window of 0 disables that sweep.
 */
import type { Database } from '../db/database.js'

/** Retention windows for the background sweep; a window of 0 disables that sweep. */
export interface RetentionConfig {
  /** How often to run a sweep (ms). Default 1 hour. */
  intervalMs?: number
  /** Delete audit_log_entries older than this many days (0 = keep forever). Default 90. */
  auditLogDays?: number
  /** Delete revoked/expired refresh tokens older than this many days (0 = keep). Default 30. */
  refreshTokenDays?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Periodically purges expired/stale auth rows so those tables can't grow unbounded. */
export class RetentionService {
  private timer: ReturnType<typeof setInterval> | null = null
  private timerGeneration = 0
  // Tracks the sweep currently in flight. The boot sweep and interval sweeps
  // run un-awaited, but stop() must be able to drain the in-flight one before
  // the caller closes the database: PGlite has a single connection, and calling
  // close() while a sweep query is still queued busy-loops the shutdown.
  private inFlight: Promise<void> | null = null
  private readonly intervalMs: number
  private readonly auditLogDays: number
  private readonly refreshTokenDays: number

  constructor(
    private db: Database,
    config: RetentionConfig = {},
    private now: () => Date = () => new Date()
  ) {
    this.intervalMs = config.intervalMs ?? 60 * 60 * 1000
    this.auditLogDays = config.auditLogDays ?? 90
    this.refreshTokenDays = config.refreshTokenDays ?? 30
  }

  /** Sweep once at boot, then on the configured interval; no-op if already running. */
  start(): void {
    if (this.timer !== null) return
    void this.sweep()
    const generation = ++this.timerGeneration
    let timer: ReturnType<typeof setInterval>
    timer = setInterval(() => {
      if (this.timer === timer && this.timerGeneration === generation) void this.sweep()
    }, this.intervalMs)
    this.timer = timer
    if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref()
  }

  /**
   * Stop future sweeps and wait for any in-flight one to settle, so the caller
   * can safely close the database without racing a queued sweep query.
   */
  async stop(): Promise<void> {
    const timer = this.timer
    this.timer = null
    this.timerGeneration += 1
    if (timer !== null) clearInterval(timer)
    const inFlight = this.inFlight
    await inFlight?.catch(() => {})
  }

  /** Run a single retention pass (also callable directly in tests). */
  sweep(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const inFlight = Promise.resolve()
      .then(() => this.runSweep())
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = null
      })
    this.inFlight = inFlight
    return inFlight
  }

  private async runSweep(): Promise<void> {
    const now = this.now()
    await this.run(`delete from auth.one_time_tokens where expires_at < now()`)
    await this.run(`delete from auth.phone_otp_cooldowns where last_sent_at < now() - interval '1 day'`)
    await this.run(`delete from auth.mfa_challenges where expires_at < now()`)
    await this.run(`delete from auth.flow_state where expires_at < now()`)
    await this.run(`delete from public.supacloud_pgredis_kv where expires_at <= now()`)
    if (this.refreshTokenDays > 0) {
      const cutoff = new Date(now.getTime() - this.refreshTokenDays * DAY_MS).toISOString()
      await this.run(`delete from auth.refresh_tokens where revoked = true and updated_at < $1`, [cutoff])
    }
    if (this.auditLogDays > 0) {
      const cutoff = new Date(now.getTime() - this.auditLogDays * DAY_MS).toISOString()
      await this.run(`delete from auth.audit_log_entries where created_at < $1`, [cutoff])
    }
  }

  private async run(sql: string, params: unknown[] = []): Promise<void> {
    try {
      await this.db.query(sql, params)
    } catch {
      // table may not exist on a subset engine (pg-mem) - skip
    }
  }
}
