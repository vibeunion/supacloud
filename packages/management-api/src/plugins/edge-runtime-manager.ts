import type { Subprocess } from "bun";
import { logger } from "../utils/logger";
import path from "node:path";
import { execSync } from "node:child_process";

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
  private maxRestarts = 10;
  private restartDelay = 500; // ms

  constructor(
    private config: {
      port: number;
    },
  ) {}

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
    // Kill any orphan processes on the port BEFORE spawning
    this.killStaleListeners();

    // Determine runner path (cwd may be project root)
    const runnerPath = path.resolve(import.meta.dir, "../../../edge-runtime/server.ts");

    this.proc = Bun.spawn(["bun", "run", runnerPath], {
      env: {
        ...process.env,
        PORT: String(this.config.port),
        EDGE_FUNCTIONS_DIR: require("../config").config.edgeFunctionsDir,
        MASTER_TOKEN: require("../config").config.masterToken,
        MANAGEMENT_API_URL: `http://127.0.0.1:${require("../config").config.port || 9090}`,
      },
      stdout: "inherit",
      stderr: "inherit",
      onExit: (_proc, code, _signal) => {
        logger.error(`[EdgeRuntime] Process exited code=${code}`);
        if (this.restartCount < this.maxRestarts) {
          this.restartCount++;
          logger.info(
            `[EdgeRuntime] Restarting in ${this.restartDelay}ms (${this.restartCount}/${this.maxRestarts})`,
          );
          setTimeout(() => this.start(), this.restartDelay);
          this.restartDelay = Math.min(this.restartDelay * 2, 30000);
        } else {
          logger.error(
            "[EdgeRuntime] Max restarts reached, giving up",
          );
        }
      },
    });
    logger.info(
      `[EdgeRuntime] Started pid=${this.proc.pid} port=${this.config.port}`,
    );

    await this.waitForReady();
    this.restartCount = 0;
    this.restartDelay = 500;
  }

  private async waitForReady(timeout = 5000) {
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
    this.maxRestarts = 0;
    this.proc?.kill();
  }
}

export const edgeRuntimeManager = new EdgeRuntimeManager({ port: 9005 });
