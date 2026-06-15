/**
 * Scheduled Function Worker.
 *
 * Polls all projects' scheduled_functions config every 60s, evaluates which
 * cron entries are due, and invokes the corresponding edge function. This is
 * a platform-level scheduler independent of pg_cron, so it works even when the
 * tenant DB has not enabled pg_cron.
 *
 * Cron parsing is intentionally minimal: 5-field expressions with '*', ranges,
 * steps, and comma lists. It computes next-fire semantics by checking whether
 * the current minute matches the expression.
 */
import { sql } from "../db";
import { config } from "../config";
import { logger } from "../utils/logger";
import { projectRepository } from "../repositories/project.repository";
import type { ScheduledFunctionConfig } from "../routes/scheduled-functions";

const POLL_INTERVAL_MS = 60_000;
const INVOKE_TIMEOUT_MS = 30_000;

interface DueSchedule {
  ref: string;
  schedule: ScheduledFunctionConfig;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) result.add(i);
      continue;
    }
    // step: a/b
    const stepIdx = trimmed.indexOf("/");
    let step = 1;
    let rangePart = trimmed;
    if (stepIdx > 0) {
      step = parseInt(trimmed.slice(stepIdx + 1), 10);
      if (!Number.isFinite(step) || step < 1) continue;
      rangePart = trimmed.slice(0, stepIdx);
    }
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const dashIdx = rangePart.indexOf("-");
      if (dashIdx > 0) {
        start = parseInt(rangePart.slice(0, dashIdx), 10);
        end = parseInt(rangePart.slice(dashIdx + 1), 10);
      } else {
        start = end = parseInt(rangePart, 10);
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (let i = start; i <= end; i += step) {
      if (i >= min && i <= max) result.add(i);
    }
  }
  return result;
}

export function isDue(cronExpr: string, date: Date): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  const m = parseField(minute, 0, 59);
  const h = parseField(hour, 0, 23);
  const dayOfMonth = parseField(dom, 1, 31);
  const monthField = parseField(month, 1, 12);
  // 0 and 7 both mean Sunday in cron.
  const dowSet = parseField(dow, 0, 7);
  if (dowSet.has(7)) dowSet.add(0);

  const minOk = m.has(date.getMinutes());
  const hourOk = h.has(date.getHours());
  const domOk = dayOfMonth.has(date.getDate());
  const monthOk = monthField.has(date.getMonth() + 1);
  const dowOk = dowSet.has(date.getDay());

  // Standard cron: when both dom and dow are restricted (not '*'), fire on either match.
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  if (domRestricted && dowRestricted) {
    return minOk && hourOk && monthOk && (domOk || dowOk);
  }
  return minOk && hourOk && monthOk && domOk && dowOk;
}

async function loadAllSchedules(): Promise<DueSchedule[]> {
  let rows: { ref: string; config: unknown }[] = [];
  try {
    rows = (await sql`
      SELECT ref, config FROM projects
      WHERE deleted_at IS NULL
    `) as { ref: string; config: unknown }[];
  } catch (err) {
    logger.debug("[scheduled-functions] failed to load projects", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }

  const due: DueSchedule[] = [];
  const now = new Date();
  for (const row of rows) {
    const cfg = (row.config && typeof row.config === "object" ? row.config : {}) as Record<string, unknown>;
    const raw = cfg.scheduled_functions;
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const schedule = item as ScheduledFunctionConfig;
      if (schedule.enabled === false) continue;
      if (!schedule.cron || !schedule.slug) continue;
      if (isDue(schedule.cron, now)) {
        due.push({ ref: row.ref, schedule });
      }
    }
  }
  return due;
}

export interface TriggerResult {
  ok: boolean;
  status?: number;
  error?: string;
}

async function invokeEdgeFunction(ref: string, schedule: ScheduledFunctionConfig): Promise<TriggerResult> {
  const url = `${config.edgeRuntimeUrl}/functions/v1/${encodeURIComponent(schedule.slug)}`;
  try {
    // Load the project service_role_key so the edge runtime accepts the call
    // even when verify_jwt is enabled. User-configured headers override defaults.
    const project = await projectRepository.findByRef(ref);
    if (!project) {
      return { ok: false, error: "Project not found" };
    }
    const defaultHeaders: Record<string, string> = {
      "x-project-ref": ref,
      "apikey": project.service_role_key,
      "authorization": `Bearer ${project.service_role_key}`,
    };
    const headers: Record<string, string> = {
      ...defaultHeaders,
      ...schedule.headers,
    };
    const init: RequestInit = {
      method: schedule.method,
      headers,
      signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
    };
    if (schedule.method === "POST" && schedule.body) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(schedule.body);
    }
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

class ScheduledFunctionWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    // Align to minute boundary, then poll every 60s.
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
    setTimeout(() => {
      this.tick();
      this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
      this.timer.unref?.();
    }, msToNextMinute);
    logger.info("[scheduled-functions] worker started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Force a config reload on next tick. We don't keep an in-memory cache of
  // schedules, so reload is a no-op that simply lets the next poll pick up
  // the latest DB state. Exposed for API routes to signal freshness.
  reload(): void {
    // no-op: schedules are always read fresh from DB on each tick.
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await loadAllSchedules();
      if (due.length === 0) return;
      logger.debug(`[scheduled-functions] ${due.length} schedule(s) due`);

      await Promise.allSettled(
        due.map(async ({ ref, schedule }) => {
          const result = await invokeEdgeFunction(ref, schedule);
          if (!result.ok) {
            logger.warn(`[scheduled-functions] invoke failed for ${ref}/${schedule.slug}`, {
              status: result.status,
              error: result.error,
            });
          }
        }),
      );
    } finally {
      this.running = false;
    }
  }

  async triggerOnce(ref: string, schedule: ScheduledFunctionConfig): Promise<TriggerResult> {
    return invokeEdgeFunction(ref, schedule);
  }
}

export const scheduledFunctionWorker = new ScheduledFunctionWorker();
