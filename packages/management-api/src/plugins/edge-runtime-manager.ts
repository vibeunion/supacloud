import type { Subprocess } from "bun";
import { logger } from "../utils/logger";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { config } from "../config";
import { ensureEdgeFunctionLogsForExistingProjects } from "../services/edge-function.service";

const EDGE_RUNTIME_CHILD_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TZ",
  "NODE_ENV",
  "BUN_ENV",
  "EDGE_RUNTIME_HOST",
  "EDGE_RUNTIME_PORT",
  "EDGE_RUNTIME_VERSION",
  "EDGE_RUNTIME_WORKER_PATH",
  "SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_FILE",
  "EDGE_FUNCTION_TIMEOUT_MS",
  "EDGE_BACKGROUND_FUNCTION_TIMEOUT_MS",
  "EDGE_BACKGROUND_PREHEAT_MODE",
  "EDGE_FOREGROUND_WORKER_SMOL",
  "EDGE_BACKGROUND_WORKER_SMOL",
  "EDGE_CONTROL_MESSAGE_TIMEOUT_MS",
  "EDGE_MAX_BODY_SIZE_MB",
  "EDGE_WAIT_UNTIL_TIMEOUT_MS",
  "EDGE_AUTH_FAILURE_WINDOW_MS",
  "EDGE_AUTH_FAILURE_LIMIT",
  "EDGE_AUTH_FAILURE_COOLDOWN_MS",
  "EDGE_AUTH_FAILURE_MAX_ENTRIES",
  "MAX_QUEUE_SIZE",
  "WORKER_POOL_SIZE",
  "BACKGROUND_WORKER_POOL_SIZE",
  "WORKER_SMOL",
  "TENANTS_DIR",
  "INTERNAL_SUPABASE_URL",
  "SUPACLOUD_INTERNAL_SUPABASE_URL",
  "SUPACLOUD_EDGE_TLS_CA",
  "SUPACLOUD_EDGE_TLS_CA_FILE",
  "SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY",
  "PGREDIS_RUNTIME_INTERNAL_URL",
  "PGREDIS_RUNTIME_INTERNAL_TOKEN",
  "PGREDIS_RUNTIME_INTERNAL_TIMEOUT_MS",
  "PGREDIS_RUNTIME_CAPABILITY_TTL_MS",
] as const;

export function buildEdgeRuntimeChildEnv(
  source: Record<string, string | undefined>,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of EDGE_RUNTIME_CHILD_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

export function isEdgeRuntimeReadyResponse(
  payload: unknown,
  expectedInstanceId: string,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const response = payload as Record<string, unknown>;
  return response.status === "ok" && response.instanceId === expectedInstanceId;
}

export function buildEdgeRuntimeCommand(
  runnerPath: string,
  options: {
    bunPath: string;
    user: string;
    group: string;
    isRoot: boolean;
    setprivPath?: string;
  },
): string[] {
  const command = [options.bunPath, "run", runnerPath];
  if (!options.isRoot) return command;
  if (!options.user) {
    throw new Error("EDGE_RUNTIME_USER is required when Management API runs as root");
  }

  const setpriv = options.setprivPath;
  if (!setpriv) {
    throw new Error("EDGE_RUNTIME_USER requires setpriv for embedded privilege separation");
  }
  return [
    setpriv,
    "--reuid",
    options.user,
    "--regid",
    options.group || options.user,
    "--clear-groups",
    "--",
    ...command,
  ];
}

function edgeRuntimeCommand(runnerPath: string): string[] {
  return buildEdgeRuntimeCommand(runnerPath, {
    bunPath: config.bunPath,
    user: config.edgeRuntimeUser,
    group: config.edgeRuntimeGroup,
    isRoot: process.getuid?.() === 0,
    setprivPath: ["/usr/bin/setpriv", "/bin/setpriv"].find(existsSync),
  });
}

/**
 * Manages the Edge Function Runner as a child Bun process.
 * The runner uses deno-compat shim to execute user-authored Deno-style functions.
 *
 * Handles lifecycle: start, health check, crash recovery with exponential backoff.
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

  async start() {
    this.stopping = false;

    const runnerPath = await this.resolveRunnerPath();

    const edgeFunctionsDir = this.resolveFunctionsDir();
    mkdirSync(edgeFunctionsDir, { recursive: true });
    await ensureEdgeFunctionLogsForExistingProjects(edgeFunctionsDir);
    const instanceId = crypto.randomUUID();

    this.proc = Bun.spawn(edgeRuntimeCommand(runnerPath), {
      env: buildEdgeRuntimeChildEnv(process.env, {
        HOME: process.getuid?.() === 0 && config.edgeRuntimeUser ? "/nonexistent" : (process.env.HOME || ""),
        PORT: String(this.config.port),
        EDGE_FUNCTIONS_DIR: edgeFunctionsDir,
        EDGE_FUNCTIONS_BASE_DIR: process.env.EDGE_FUNCTIONS_BASE_DIR || edgeFunctionsDir,
        EDGE_RUNTIME_MASTER_KEY: config.edgeRuntimeMasterKey,
        EDGE_RUNTIME_INSTANCE_ID: instanceId,
        MANAGEMENT_API_URL: `http://127.0.0.1:${config.port || 9090}`,
      }),
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

    await this.waitForReady(instanceId);
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

  private async waitForReady(expectedInstanceId: string, timeout = 15_000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const child = this.proc;
      if (!child) {
        throw new Error(
          `Edge Runtime exited before becoming ready on port ${this.config.port}; the port may be occupied by another service`,
        );
      }
      try {
        const res = await fetch(
          `http://127.0.0.1:${this.config.port}/health`,
        );
        const payload: unknown = res.ok ? await res.json() : null;
        if (
          isEdgeRuntimeReadyResponse(payload, expectedInstanceId)
          && this.proc === child
          && child.exitCode === null
        ) return;
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

const [, edgeRuntimePortStr] = (config.edgeRuntimeInternal || "127.0.0.1:9005").split(":");
const edgeRuntimePort = parseInt(edgeRuntimePortStr, 10) || 9005;

export const edgeRuntimeManager = new EdgeRuntimeManager({ port: edgeRuntimePort });
