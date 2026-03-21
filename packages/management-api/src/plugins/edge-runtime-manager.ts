import type { Subprocess } from "bun";
import { logger } from "../utils/logger";

/**
 * Manages the Edge Runtime as a separate Bun process.
 * Handles lifecycle: start, health check, crash recovery with exponential backoff.
 */
export class EdgeRuntimeManager {
  private proc: Subprocess | null = null;
  private restartCount = 0;
  private maxRestarts = 10;
  private restartDelay = 500; // ms

  constructor(
    private config: {
      scriptPath: string;
      port: number;
      poolSize: number;
    },
  ) {}

  async start() {
    this.proc = Bun.spawn(["bun", "run", this.config.scriptPath], {
      env: {
        ...process.env,
        PORT: String(this.config.port),
        WORKER_POOL_SIZE: String(this.config.poolSize),
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
