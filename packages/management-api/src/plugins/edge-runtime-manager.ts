import type { Subprocess } from "bun";
import { logger } from "../utils/logger";
import path from "node:path";

/**
 * Manages the Edge Function Runner as a child Bun process.
 * The runner uses deno-compat shim to execute user-authored Deno-style functions.
 *
 * Handles lifecycle: start, health check, crash recovery with exponential backoff.
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

  async start() {
    // Determine runner path (cwd is packages/management-api)
    const runnerPath = path.resolve(process.cwd(), "../edge-runtime/server.ts");

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

export const edgeRuntimeManager = new EdgeRuntimeManager({ port: 9000 });
