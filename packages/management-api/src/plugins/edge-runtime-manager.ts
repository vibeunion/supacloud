import type { Subprocess } from "bun";
import { logger } from "../utils/logger";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { config } from "../config";

/**
 * Manages the Edge Function Runner as a child Bun process.
 * The runner uses deno-compat shim to execute user-authored Deno-style functions.
 *
 * Handles lifecycle: start, health check, crash recovery with exponential backoff.
 * Includes port-exclusivity guard to prevent SO_REUSEPORT ghost processes.
 */
export class EdgeRuntimeManager {
  private proc: Subprocess | null = null;
  private restartCount = 0;
  private restartDelay = 500; // ms
  private stopping = false;

  constructor(
    private config: {
      port: number;
    },
  ) {}

  private async resolveRunnerPath(): Promise<string> {
    const candidates = [
      process.env.EDGE_RUNTIME_SERVER_PATH,
      path.resolve(process.cwd(), "../edge-runtime/server.ts"),
      path.resolve(process.cwd(), "packages/edge-runtime/server.ts"),
      path.resolve(import.meta.dir, "../../../edge-runtime/server.ts"),
      "/opt/supacloud/packages/edge-runtime/server.ts",
      "/opt/supacloud/edge-runtime/server.ts",
    ].filter((candidate): candidate is string => !!candidate);

    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) {
        return candidate;
      }
    }

    throw new Error(
      `Edge Runtime server.ts not found. Tried: ${candidates.join(", ")}. ` +
      "Set EDGE_RUNTIME_SERVER_PATH or EDGE_RUNTIME_MODE=external.",
    );
  }

  /**
   * Kill any stale processes listening on our target port.
   * Prevents SO_REUSEPORT ghost processes from co-existing with the new runtime,
   * which would cause ~50% of requests to be routed to the old (stale) process.
   */
  private killStaleListeners(): void {
    const port = this.config.port;
    try {
      // Use fuser (part of psmisc, widely available) or fall back to lsof
      const out = execSync(
        `lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || fuser ${port}/tcp 2>/dev/null || true`,
        { encoding: "utf-8" },
      ).trim();
      if (!out) return;

      const myPid = process.pid;
      const childPid = this.proc?.pid;
      const pids = out
        .split(/[\s\n]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((p) => !isNaN(p) && p !== myPid && p !== childPid);

      for (const pid of pids) {
        logger.warn(`[EdgeRuntime] Killing stale listener pid=${pid} on port ${port}`);
        try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      }

      if (pids.length > 0) {
        // Brief wait for graceful shutdown
        execSync("sleep 0.5");
        // Force-kill survivors
        for (const pid of pids) {
          try {
            process.kill(pid, 0); // alive check
            process.kill(pid, "SIGKILL");
            logger.warn(`[EdgeRuntime] Force-killed stale pid=${pid}`);
          } catch { /* already gone */ }
        }
        logger.info(`[EdgeRuntime] Cleared ${pids.length} stale process(es) on port ${port}`);
      }
    } catch {
      // lsof/fuser may not be installed — best-effort guard
    }
  }

  async start() {
    this.stopping = false;

    const runnerPath = await this.resolveRunnerPath();

    // Kill any orphan processes on the port BEFORE spawning
    this.killStaleListeners();

    const edgeFunctionsDir = this.resolveFunctionsDir();
    mkdirSync(edgeFunctionsDir, { recursive: true });

    this.proc = Bun.spawn(["bun", "run", runnerPath], {
      env: {
        ...process.env,
        PORT: String(this.config.port),
        EDGE_FUNCTIONS_DIR: edgeFunctionsDir,
        EDGE_FUNCTIONS_BASE_DIR: process.env.EDGE_FUNCTIONS_BASE_DIR || edgeFunctionsDir,
        EDGE_RUNTIME_MASTER_KEY: config.edgeRuntimeMasterKey,
        MASTER_TOKEN: config.masterToken,
        MANAGEMENT_API_URL: `http://127.0.0.1:${config.port || 9090}`,
      },
      stdout: "inherit",
      stderr: "inherit",
      onExit: (_proc, code, signal) => {
        logger.error(`[EdgeRuntime] Process exited code=${code} signal=${signal ?? "none"}`);
        this.proc = null;

        if (this.stopping) {
          logger.info("[EdgeRuntime] Stop requested, not restarting child process");
          return;
        }

        this.restartCount++;
        const nextDelay = this.restartDelay;
        logger.warn(
          `[EdgeRuntime] Restarting in ${nextDelay}ms (attempt ${this.restartCount}, capped backoff)`,
        );
        setTimeout(() => {
          this.start().catch((err: unknown) =>
            logger.error("[EdgeRuntime] Restart attempt failed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }, nextDelay);
        this.restartDelay = Math.min(this.restartDelay * 2, 30000);
      },
    });
    logger.info(
      `[EdgeRuntime] Started pid=${this.proc.pid} port=${this.config.port}`,
    );

    await this.waitForReady();
    this.restartCount = 0;
    this.restartDelay = 500;
  }

  private resolveFunctionsDir(): string {
    if (process.env.EDGE_FUNCTIONS_DIR) return path.resolve(process.env.EDGE_FUNCTIONS_DIR);
    if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
      return path.resolve(process.cwd(), ".tmp/edge-functions");
    }
    return config.edgeFunctionsDir;
  }

  private async waitForReady(timeout = 15_000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const res = await fetch(
          `http://127.0.0.1:${this.config.port}/health`,
        );
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await Bun.sleep(100);
    }
    throw new Error("Edge Runtime startup timeout");
  }

  stop() {
    this.stopping = true;
    this.proc?.kill();
  }
}

const [, edgeRuntimePortStr] = (config.edgeRuntimeInternal || "127.0.0.1:9000").split(":");
const edgeRuntimePort = parseInt(edgeRuntimePortStr, 10) || 9000;

export const edgeRuntimeManager = new EdgeRuntimeManager({ port: edgeRuntimePort });
