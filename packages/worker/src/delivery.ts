import { createPgflowQueueWorker, type TaskHandler } from "./index.js";

type Environment = Readonly<Record<string, string | undefined>>;

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("WORKER_DELIVERY_INVALID");
  return value;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || /[\r\n\0]/.test(value) || !pattern.test(value))
    throw new Error("WORKER_DELIVERY_INVALID");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("WORKER_DELIVERY_INVALID");
  return value as Record<string, unknown>;
}

export interface WorkerDelivery {
  projectRef: string;
  queueName: string;
  taskKey: string;
  user: string;
  runtimePath: string;
  releaseDirectory: string;
  entrypoint: string;
  environmentFile: string;
  concurrency: number;
  maxPgConnections: number;
  visibilityTimeoutSeconds: number;
  retryLimit: number;
  cpuQuotaPercent: number;
  memoryMaxMiB: number;
  tasksMax: number;
  stopTimeoutSeconds: number;
}

const keys: readonly (keyof WorkerDelivery)[] = [
  "projectRef", "queueName", "taskKey", "user", "runtimePath", "releaseDirectory",
  "entrypoint", "environmentFile", "concurrency", "maxPgConnections",
  "visibilityTimeoutSeconds", "retryLimit", "cpuQuotaPercent", "memoryMaxMiB",
  "tasksMax", "stopTimeoutSeconds",
];

function absolutePath(value: unknown): string {
  const path = text(value, /^\/[A-Za-z0-9_./-]+$/);
  if (path.endsWith("/") || path.split("/").some(part => part === "." || part === ".."))
    throw new Error("WORKER_DELIVERY_INVALID");
  return path;
}

/** Non-secret manifest. Reject unknown keys and systemd/shell interpolation. */
export function parseWorkerDelivery(value: unknown): Readonly<WorkerDelivery> {
  const input = record(value);
  if (Object.keys(input).some(key => !keys.includes(key as keyof WorkerDelivery)))
    throw new Error("WORKER_DELIVERY_INVALID");
  const result: WorkerDelivery = {
    projectRef: text(input.projectRef, /^[a-z0-9][a-z0-9-]{0,99}$/),
    queueName: text(input.queueName, /^scw_[a-z0-9_]{1,40}$/),
    taskKey: text(input.taskKey, /^[a-z][a-z0-9_.-]{0,99}$/),
    user: text(input.user, /^[a-z_][a-z0-9_-]{0,30}$/),
    runtimePath: absolutePath(input.runtimePath),
    releaseDirectory: absolutePath(input.releaseDirectory),
    entrypoint: absolutePath(input.entrypoint),
    environmentFile: absolutePath(input.environmentFile),
    concurrency: integer(input.concurrency, 1, 32),
    maxPgConnections: integer(input.maxPgConnections, 1, 16),
    visibilityTimeoutSeconds: integer(input.visibilityTimeoutSeconds, 15, 3600),
    retryLimit: integer(input.retryLimit, 0, 10),
    cpuQuotaPercent: integer(input.cpuQuotaPercent, 1, 6400),
    memoryMaxMiB: integer(input.memoryMaxMiB, 64, 1048576),
    tasksMax: integer(input.tasksMax, 16, 4096),
    stopTimeoutSeconds: integer(input.stopTimeoutSeconds, 5, 3600),
  };
  if (result.user === "root" || !result.entrypoint.startsWith(`${result.releaseDirectory}/`))
    throw new Error("WORKER_DELIVERY_INVALID");
  return Object.freeze(result);
}

export function renderWorkerService(value: unknown): string {
  const plan = parseWorkerDelivery(value);
  // ExecStart assignments override the secret file; Bun must not load a release .env.
  const environment = [
    `SUPACLOUD_PROJECT_REF=${plan.projectRef}`,
    `SUPACLOUD_WORKER_QUEUE=${plan.queueName}`,
    `SUPACLOUD_WORKER_TASK=${plan.taskKey}`,
    `SUPACLOUD_WORKER_CONCURRENCY=${plan.concurrency}`,
    `SUPACLOUD_WORKER_PG_CONNECTIONS=${plan.maxPgConnections}`,
    `SUPACLOUD_WORKER_VISIBILITY_SECONDS=${plan.visibilityTimeoutSeconds}`,
    `SUPACLOUD_WORKER_RETRY_LIMIT=${plan.retryLimit}`,
  ].join(" ");
  return `[Unit]
Description=SupaCloud queue worker ${plan.projectRef}/${plan.queueName}
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
User=${plan.user}
WorkingDirectory=${plan.releaseDirectory}
EnvironmentFile=${plan.environmentFile}
ExecStart=/usr/bin/env ${environment} ${plan.runtimePath} --no-env-file ${plan.entrypoint}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
KillMode=control-group
TimeoutStopSec=${plan.stopTimeoutSeconds}
CPUAccounting=yes
CPUQuota=${plan.cpuQuotaPercent}%
MemoryAccounting=yes
MemoryMax=${plan.memoryMaxMiB}M
MemorySwapMax=0
TasksMax=${plan.tasksMax}
OOMPolicy=stop
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

function environmentInteger(env: Environment, key: string, min: number, max: number): number {
  const value = text(env[key], /^(0|[1-9][0-9]*)$/);
  return integer(Number(value), min, max);
}

/** The application owns decoding, current authorization and durable side effects. */
export async function startQueueWorkerFromEnvironment<T>(
  handler: TaskHandler<T>,
  env: Environment = process.env,
) {
  const worker = createPgflowQueueWorker({
    projectRef: text(env.SUPACLOUD_PROJECT_REF, /^[a-z0-9][a-z0-9-]{0,99}$/),
    queueName: text(env.SUPACLOUD_WORKER_QUEUE, /^scw_[a-z0-9_]{1,40}$/),
    taskKey: text(env.SUPACLOUD_WORKER_TASK, /^[a-z][a-z0-9_.-]{0,99}$/),
    connectionString: text(env.EDGE_WORKER_DB_URL, /^postgres(?:ql)?:\/\/.+$/),
    concurrency: environmentInteger(env, "SUPACLOUD_WORKER_CONCURRENCY", 1, 32),
    maxPgConnections: environmentInteger(env, "SUPACLOUD_WORKER_PG_CONNECTIONS", 1, 16),
    visibilityTimeoutSeconds: environmentInteger(env, "SUPACLOUD_WORKER_VISIBILITY_SECONDS", 15, 3600),
    retryLimit: environmentInteger(env, "SUPACLOUD_WORKER_RETRY_LIMIT", 0, 10),
  }, handler);
  await worker.start();
  return worker;
}
