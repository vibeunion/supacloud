import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { type VictoriaLogWrite, victoriaLogsService } from "../services/victorialogs.service";
import { logger } from "../utils/logger";

const JOURNAL_UNITS = [
  "supacloud.service",
  "supacloud-caddy.service",
  "supacloud-edge-runtime.service",
  "supacloud-pgredis-runtime.service",
  "supacloud-realtime.service",
  "patroni.service",
  "supacloud-gotrue@*.service",
  "supacloud-pgrst@*.service",
  "supacloud-storage@*.service",
  "supacloud-postgres@*.service",
] as const;
const JOURNAL_INITIAL_BACKFILL = "15 minutes ago";
const FUNCTION_POLL_MS = 5_000;
const MAX_FUNCTION_READ_BYTES = 1_048_576;
const INITIAL_FUNCTION_BACKFILL_BYTES = 1_048_576;
const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type CollectorState = {
  journalCursor?: string;
  functionOffsets: Record<string, number>;
};

type JournalRecord = Record<string, unknown>;
type JournalEvent = { cursor: string; event: VictoriaLogWrite };

const SENSITIVE_PATTERNS = [
  /(authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
  /(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,
  /(jwt|access[_-]?token|refresh[_-]?token|id[_-]?token)\s*[:=]\s*[^\s,;]+/gi,
  /(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s,;]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
] as const;

export function redactLogMessage(message: string): string {
  return SENSITIVE_PATTERNS.reduce((value, pattern) => value.replace(pattern, "$1=[REDACTED]"), message);
}

function normalizeTimestamp(value: unknown): string {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function severityFor(priority: unknown, message: string): VictoriaLogWrite["severity"] {
  const level = Number(priority);
  if (Number.isFinite(level)) {
    if (level <= 3) return "error";
    if (level === 4) return "warning";
    if (level >= 7) return "debug";
  }
  if (/\b(error|fatal|panic)\b/i.test(message)) return "error";
  if (/\bwarn(?:ing)?\b/i.test(message)) return "warning";
  return "info";
}

export function projectLogFields(unit: string): { projectRef?: string; service: string } {
  const match = /^supacloud-(gotrue|pgrst|storage|postgres)@([A-Za-z0-9_-]+)\.service$/.exec(unit);
  if (match) {
    const serviceByUnit: Record<string, string> = {
      gotrue: "auth",
      pgrst: "postgrest",
      storage: "storage",
      postgres: "database",
    };
    return { projectRef: match[2], service: serviceByUnit[match[1]] };
  }
  if (unit === "supacloud-edge-runtime.service") return { service: "functions-runtime" };
  if (unit === "supacloud-caddy.service") return { service: "gateway" };
  return { service: unit.replace(/^supacloud-/, "").replace(/\.service$/, "") || "system" };
}

export function journalctlArgs(cursor?: string): string[] {
  const args = ["journalctl", "--follow", "--no-pager", "--output=json"];
  if (cursor) args.push(`--after-cursor=${cursor}`);
  else args.push(`--since=${JOURNAL_INITIAL_BACKFILL}`);
  for (const unit of JOURNAL_UNITS) args.push("-u", unit);
  return args;
}

export function parseJournalEvent(value: JournalRecord): JournalEvent | null {
  const cursor = typeof value.__CURSOR === "string" ? value.__CURSOR : "";
  const unit = typeof value._SYSTEMD_UNIT === "string" ? value._SYSTEMD_UNIT : "";
  const message = typeof value.MESSAGE === "string" ? value.MESSAGE : "";
  if (!cursor || !unit || !message) return null;
  const fields = projectLogFields(unit);
  return {
    cursor,
    event: {
      timestamp: normalizeTimestamp(value.__REALTIME_TIMESTAMP ? Number(value.__REALTIME_TIMESTAMP) / 1000 : undefined),
      message: redactLogMessage(message),
      service: fields.service,
      projectRef: fields.projectRef,
      severity: severityFor(value.PRIORITY, message),
      unit,
    },
  };
}

async function loadState(stateFile: string): Promise<CollectorState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as Partial<CollectorState>;
    return {
      journalCursor: typeof parsed.journalCursor === "string" ? parsed.journalCursor : undefined,
      functionOffsets: parsed.functionOffsets && typeof parsed.functionOffsets === "object" ? parsed.functionOffsets : {},
    };
  } catch {
    return { functionOffsets: {} };
  }
}

async function saveState(stateFile: string, state: CollectorState): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o750 });
  const staged = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(staged, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(staged, stateFile);
}

function functionLogRecord(ref: string, rawLine: string): VictoriaLogWrite | null {
  try {
    const parsed = JSON.parse(rawLine) as Record<string, unknown>;
    const message = typeof parsed.message === "string" ? parsed.message : rawLine;
    return {
      timestamp: normalizeTimestamp(parsed.timestamp),
      message: redactLogMessage(message),
      service: "functions",
      projectRef: ref,
      severity: severityFor(parsed.severity ?? parsed.level, message),
      unit: "supacloud-edge-function",
    };
  } catch {
    return {
      timestamp: new Date().toISOString(),
      message: redactLogMessage(rawLine),
      service: "functions",
      projectRef: ref,
      severity: severityFor(undefined, rawLine),
      unit: "supacloud-edge-function",
    };
  }
}

export class LocalLogCollector {
  private readonly stateFile: string;
  private state: CollectorState = { functionOffsets: {} };
  private journalProcess: ReturnType<typeof Bun.spawn> | null = null;
  private functionTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private functionPollRunning = false;

  constructor(
    private readonly options: {
      stateDirectory?: string;
      functionsDirectory?: string;
      journalEnabled?: boolean;
      write?: (events: readonly VictoriaLogWrite[]) => Promise<void>;
    } = {},
  ) {
    this.stateFile = path.join(options.stateDirectory || config.logCollectorStateDir, "state.json");
  }

  private get functionsDirectory(): string {
    return this.options.functionsDirectory || config.edgeFunctionsDir;
  }

  private get journalEnabled(): boolean {
    return this.options.journalEnabled ?? config.logCollectorJournalEnabled;
  }

  private async write(events: readonly VictoriaLogWrite[]): Promise<void> {
    await (this.options.write || ((input) => victoriaLogsService.ingest(input)))(events);
  }

  async start(): Promise<void> {
    if (this.journalProcess || this.functionTimer || this.stopped) return;
    this.state = await loadState(this.stateFile);
    if (this.journalEnabled) this.startJournalLoop();
    void this.collectFunctionLogs();
    this.functionTimer = setInterval(() => void this.collectFunctionLogs(), FUNCTION_POLL_MS);
    this.functionTimer.unref?.();
    logger.info("[LocalLogCollector] started", { stateFile: this.stateFile, journalEnabled: this.journalEnabled });
  }

  stop(): void {
    this.stopped = true;
    this.journalProcess?.kill();
    this.journalProcess = null;
    if (this.functionTimer) clearInterval(this.functionTimer);
    this.functionTimer = null;
    logger.info("[LocalLogCollector] stopped");
  }

  private startJournalLoop(): void {
    if (this.stopped) return;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(journalctlArgs(this.state.journalCursor), { stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      logger.warn("[LocalLogCollector] journald is unavailable; function log collection remains active", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.journalProcess = proc;
    void this.readJournal(proc);
    void proc.exited.then(async (exitCode) => {
      if (this.stopped || this.journalProcess !== proc) return;
      logger.warn("[LocalLogCollector] journal reader exited; retrying", { exitCode });
      // A vacuumed/rotated journal rejects an old cursor. Discard it after a
      // failed reader so the next attempt can make bounded progress instead
      // of retrying the same invalid cursor forever.
      if (exitCode !== 0 && this.state.journalCursor) {
        this.state.journalCursor = undefined;
        await saveState(this.stateFile, this.state);
      }
      await Bun.sleep(2_000);
      if (!this.stopped && this.journalProcess === proc) this.startJournalLoop();
    });
  }

  private async readJournal(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("journalctl stdout pipe is unavailable");
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let batch: JournalEvent[] = [];
    try {
      while (!this.stopped && this.journalProcess === proc) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = parseJournalEvent(JSON.parse(line) as JournalRecord);
            if (event) batch.push(event);
          } catch {
            // journalctl can emit a cursor marker when --show-cursor is used by an operator; ignore it.
          }
          if (batch.length >= 100) {
            await this.flushJournalBatch(batch);
            batch = [];
          }
        }
        if (batch.length > 0) {
          await this.flushJournalBatch(batch);
          batch = [];
        }
      }
    } catch (error) {
      if (!this.stopped) {
        logger.warn("[LocalLogCollector] journal ingestion paused", {
          error: error instanceof Error ? error.message : String(error),
        });
        proc.kill();
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async flushJournalBatch(batch: readonly JournalEvent[]): Promise<void> {
    await this.write(batch.map((item) => item.event));
    this.state.journalCursor = batch[batch.length - 1]?.cursor;
    await saveState(this.stateFile, this.state);
  }

  private async collectFunctionLogs(): Promise<void> {
    if (this.stopped || this.functionPollRunning) return;
    this.functionPollRunning = true;
    try {
      const projects = await readdir(this.functionsDirectory, { withFileTypes: true }).catch(() => []);
      for (const project of projects) {
        if (!project.isDirectory() || !PROJECT_REF_PATTERN.test(project.name)) continue;
        const logDirectory = path.join(this.functionsDirectory, project.name, ".logs");
        const logDirectoryInfo = await lstat(logDirectory).catch(() => null);
        if (!logDirectoryInfo?.isDirectory() || logDirectoryInfo.isSymbolicLink()) continue;
        const files = await readdir(logDirectory, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".log")) continue;
          await this.collectFunctionFile(project.name, path.join(logDirectory, file.name));
        }
      }
    } catch (error) {
      logger.warn("[LocalLogCollector] function log scan failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.functionPollRunning = false;
    }
  }

  private async collectFunctionFile(ref: string, file: string): Promise<void> {
    // Function source directories are operator-controlled. Do not follow a
    // symlink out of the per-project .logs directory while running as root.
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) return;
    const previous = this.state.functionOffsets[file];
    const offset = previous === undefined
      ? Math.max(0, info.size - INITIAL_FUNCTION_BACKFILL_BYTES)
      : Math.min(previous, info.size);
    if (offset === info.size) return;

    const length = Math.min(MAX_FUNCTION_READ_BYTES, info.size - offset);
    const handle = await open(file, "r");
    const data = Buffer.alloc(length);
    try {
      const { bytesRead } = await handle.read(data, 0, length, offset);
      const text = data.subarray(0, bytesRead).toString("utf8");
      const newline = text.lastIndexOf("\n");
      if (newline < 0) {
        // A malformed producer can write an unbounded record. Advance past
        // this bounded chunk so it cannot permanently block later log lines.
        this.state.functionOffsets[file] = offset + bytesRead;
        await saveState(this.stateFile, this.state);
        return;
      }
      const complete = text.slice(0, newline + 1);
      const nextOffset = offset + Buffer.byteLength(complete, "utf8");
      const events = complete.split("\n").filter(Boolean).map((line) => functionLogRecord(ref, line)).filter((event): event is VictoriaLogWrite => event !== null);
      if (events.length > 0) await this.write(events);
      this.state.functionOffsets[file] = nextOffset;
      await saveState(this.stateFile, this.state);
    } finally {
      await handle.close();
    }
  }
}

let collector: LocalLogCollector | null = null;

export function startLocalLogCollector(): void {
  if (!config.logsEnabled) return;
  if (collector) return;
  collector = new LocalLogCollector();
  void collector.start().catch((error: unknown) => {
    logger.warn("[LocalLogCollector] failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    collector = null;
  });
}

export function stopLocalLogCollector(): void {
  collector?.stop();
  collector = null;
}
