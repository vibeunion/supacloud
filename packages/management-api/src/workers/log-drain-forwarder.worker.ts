/**
 * Log Drain Forwarder Worker.
 *
 * Continuously polls logs from all projects that have configured log drains
 * and forwards new log entries to the configured drain endpoints. This
 * complements the passive forwarding in project-logs.service.ts (which only
 * fires when someone queries logs) with an active background poller.
 *
 * The worker tracks the last-seen timestamp per project+source to avoid
 * forwarding duplicate entries across poll cycles.
 */
import { sql } from "../db";
import { logger } from "../utils/logger";
import { forwardLogEvent } from "../routes/log-drains";
import { normalizeProjectConfig } from "../utils/project-config";

const POLL_INTERVAL_MS = 15_000; // 15s poll cycle
const MAX_ENTRIES_PER_POLL = 50;

interface DrainForwardState {
  // key: `${ref}:${source}` -> last forwarded journal cursor timestamp (ms epoch)
  lastSeenMs: Map<string, number>;
}

const state: DrainForwardState = {
  lastSeenMs: new Map(),
};

let workerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Query all projects that have at least one enabled drain configured.
 */
async function getProjectsWithDrains(): Promise<
  { ref: string; config: Record<string, unknown> }[]
> {
  try {
    const rows = await sql`
      SELECT ref, config FROM projects
      WHERE deleted_at IS NULL AND status = 'active'
    `;
    return rows
      .map((r: Record<string, unknown>) => ({
        ref: String(r.ref),
        config: normalizeProjectConfig(r.config),
      }))
      .filter((r: { ref: string; config: Record<string, unknown> }) => {
        const drains = (r.config.log_drains as Record<string, unknown>[] | undefined) || [];
        return drains.some((d) => d && d.enabled !== false);
      });
  } catch (err: unknown) {
    logger.debug("[log-drain-forwarder] failed to list projects", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Fetch recent journald entries for a given systemd unit and source label.
 * Returns parsed log entries sorted oldest-first.
 */
async function fetchRecentLogs(
  unitName: string,
  source: string,
  limit: number,
): Promise<
  { timestamp: string; message: string; severity: string; source: string; rawMs: number }[]
> {
  try {
    const proc = Bun.spawn(
      ["journalctl", "-u", unitName, "-o", "json", "-n", String(limit), "--no-pager"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const entries: { timestamp: string; message: string; severity: string; source: string; rawMs: number }[] = [];
    for (const line of text.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const tsNum = parseInt(entry.__REALTIME_TIMESTAMP || "0");
        const ms = Math.floor(tsNum / 1000) || Date.now();
        const message = entry.MESSAGE || "";
        if (!message) continue;

        let severity = "info";
        const prio = parseInt(entry.PRIORITY || "6");
        if (prio <= 3) severity = "error";
        else if (prio === 4) severity = "warning";
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes("error") || lowerMsg.includes("fatal")) severity = "error";
        else if (lowerMsg.includes("warn")) severity = "warning";

        entries.push({
          timestamp: new Date(ms).toISOString(),
          message,
          severity,
          source,
          rawMs: ms,
        });
      } catch {
        // Skip unparseable lines
      }
    }
    return entries.sort((a, b) => a.rawMs - b.rawMs);
  } catch {
    return [];
  }
}

/**
 * Main poll cycle: for each project with drains, fetch logs from all sources,
 * filter out already-seen entries, and forward new ones.
 */
async function pollOnce(): Promise<void> {
  const projects = await getProjectsWithDrains();
  if (projects.length === 0) return;

  for (const { ref } of projects) {
    const sources: { unit: string; label: string }[] = [
      { unit: `supacloud-gotrue@${ref}`, label: "auth" },
      { unit: `supacloud-pgrst@${ref}`, label: "api" },
    ];

    for (const { unit, label } of sources) {
      const key = `${ref}:${label}`;
      const lastMs = state.lastSeenMs.get(key) || 0;

      try {
        const entries = await fetchRecentLogs(unit, label, MAX_ENTRIES_PER_POLL);
        const newEntries = entries.filter((e) => e.rawMs > lastMs);

        for (const entry of newEntries) {
          void forwardLogEvent(ref, {
            timestamp: entry.timestamp,
            source: entry.source,
            severity: entry.severity,
            message: entry.message,
            metadata: { unit, poller: "log-drain-forwarder" },
          });
        }

        if (newEntries.length > 0) {
          state.lastSeenMs.set(key, newEntries[newEntries.length - 1].rawMs);
        }
      } catch (err: unknown) {
        logger.debug(`[log-drain-forwarder] error polling ${key}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export function startLogDrainForwarder(): void {
  if (workerTimer) {
    logger.warn("[log-drain-forwarder] already running");
    return;
  }
  logger.info(`[log-drain-forwarder] starting, poll interval ${POLL_INTERVAL_MS}ms`);
  // Run first cycle immediately, then on interval.
  void pollOnce();
  workerTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  // Don't block process exit.
  if (workerTimer && typeof workerTimer.unref === "function") {
    workerTimer.unref();
  }
}

export function stopLogDrainForwarder(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info("[log-drain-forwarder] stopped");
  }
}
