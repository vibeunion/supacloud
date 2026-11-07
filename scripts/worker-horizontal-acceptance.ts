import { readFile, writeFile } from "node:fs/promises";
import { acceptWorkerMixedLoad, type WorkerLoadSpec } from "../packages/worker/src/acceptance";

type Properties = ReadonlyMap<string, string>;

export interface CgroupExpectation {
  cpuLimit: number;
  memoryLimitMiB: number;
}

export interface CgroupReadback {
  unit: string;
  controlGroup: string;
  cpuMax: string;
  memoryMax: string;
  memorySwapMax: string;
  passed: boolean;
  failures: string[];
}

export function parseJsonCommand(raw: string | undefined, name = "RESTART"): string[] {
  if (!raw) throw new Error(`WORKER_ACCEPTANCE_${name}_COMMAND_REQUIRED`);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`WORKER_ACCEPTANCE_${name}_COMMAND_INVALID`); }
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || !item)) {
    throw new Error(`WORKER_ACCEPTANCE_${name}_COMMAND_INVALID`);
  }
  return value;
}

export function parseSystemdProperties(stdout: string): Properties {
  const values = new Map<string, string>();
  for (const line of stdout.trim().split("\n")) {
    const index = line.indexOf("=");
    if (index < 1 || values.has(line.slice(0, index))) throw new Error("WORKER_ACCEPTANCE_SYSTEMD_INVALID");
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

function systemdMicroseconds(value: string | undefined): number | null {
  if (!value || !/^[0-9]+(?:\.[0-9]+)?(?:us|ms|s|m|h)$/.test(value)) return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)(us|ms|s|m|h)$/.exec(value);
  if (!match) return null;
  const units = { us: 1, ms: 1_000, s: 1_000_000, m: 60_000_000, h: 3_600_000_000 } as const;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

export function verifyCgroupReadback(
  unit: string,
  properties: Properties,
  files: { cpuMax: string; memoryMax: string; memorySwapMax: string },
  expected: CgroupExpectation,
): CgroupReadback {
  const controlGroup = properties.get("ControlGroup") ?? "";
  const failures: string[] = [];
  if (!/^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_.:@-]+$/.test(controlGroup)) failures.push("CONTROL_GROUP");
  if (!controlGroup.endsWith(`/${unit}`)) failures.push("CONTROL_GROUP_UNIT");
  const cpu = /^([1-9][0-9]*) ([1-9][0-9]*)\s*$/.exec(files.cpuMax.trim());
  if (!cpu || Math.abs(Number(cpu[1]) / Number(cpu[2]) - expected.cpuLimit) > 0.00001) failures.push("CPU_MAX");
  if (files.memoryMax.trim() !== String(expected.memoryLimitMiB * 1024 * 1024)) failures.push("MEMORY_MAX");
  if (files.memorySwapMax.trim() !== "0") failures.push("MEMORY_SWAP_MAX");
  const quota = systemdMicroseconds(properties.get("CPUQuotaPerSecUSec"));
  if (quota === null || Math.abs(quota - expected.cpuLimit * 1_000_000) > 0.5) failures.push("SYSTEMD_CPU_QUOTA");
  if (properties.get("MemoryMax") !== String(expected.memoryLimitMiB * 1024 * 1024)) failures.push("SYSTEMD_MEMORY_MAX");
  if (properties.get("MemorySwapMax") !== "0") failures.push("SYSTEMD_MEMORY_SWAP_MAX");
  if (properties.get("CPUAccounting") !== "yes" || properties.get("MemoryAccounting") !== "yes") failures.push("ACCOUNTING");
  if (properties.get("KillMode") !== "control-group") failures.push("KILL_MODE");
  return { unit, controlGroup, cpuMax: files.cpuMax.trim(), memoryMax: files.memoryMax.trim(), memorySwapMax: files.memorySwapMax.trim(), passed: failures.length === 0, failures };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_INVALID`);
  return value;
}

function number(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name}_INVALID`);
  return value;
}

function url(path: string): string {
  return new URL(path, required("WORKER_ACCEPTANCE_TARGET_URL")).toString();
}

async function command(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn({ cmd: args, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`WORKER_ACCEPTANCE_COMMAND_FAILED:${args[0]}:${stderr.slice(0, 200)}`);
  }
  return { exitCode, stdout };
}

async function jsonRequest(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${required("WORKER_ACCEPTANCE_TOKEN")}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(url(path), { ...init, headers, signal: AbortSignal.timeout(integer("WORKER_ACCEPTANCE_REQUEST_TIMEOUT_MS", 5000, 100, 120_000)) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || body === null || typeof body !== "object" || Array.isArray(body)) throw new Error(`WORKER_ACCEPTANCE_HTTP_${response.status}`);
  return body as Record<string, unknown>;
}

async function readCgroups(units: string[], expected: CgroupExpectation): Promise<CgroupReadback[]> {
  if (process.platform !== "linux") throw new Error("WORKER_ACCEPTANCE_LINUX_REQUIRED");
  const readbacks: CgroupReadback[] = [];
  for (const unit of units) {
    const result = await command(["systemctl", "show", unit, "--property=CPUQuotaPerSecUSec,MemoryMax,MemorySwapMax,CPUAccounting,MemoryAccounting,KillMode,ControlGroup", "--all", "--no-pager"]);
    const properties = parseSystemdProperties(result.stdout);
    const controlGroup = properties.get("ControlGroup") ?? "";
    if (!controlGroup) throw new Error(`WORKER_ACCEPTANCE_CGROUP_MISSING:${unit}`);
    const root = `/sys/fs/cgroup${controlGroup}`;
    const files = {
      cpuMax: await readFile(`${root}/cpu.max`, "utf8"),
      memoryMax: await readFile(`${root}/memory.max`, "utf8"),
      memorySwapMax: await readFile(`${root}/memory.swap.max`, "utf8"),
    };
    readbacks.push(verifyCgroupReadback(unit, properties, files, expected));
  }
  return readbacks;
}

function unitsFromEnvironment(): string[] {
  let value: unknown;
  try { value = JSON.parse(required("WORKER_ACCEPTANCE_UNITS_JSON")); } catch { throw new Error("WORKER_ACCEPTANCE_UNITS_JSON_INVALID"); }
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || !/^[A-Za-z0-9_.:@-]+\.service$/.test(item))) {
    throw new Error("WORKER_ACCEPTANCE_UNITS_JSON_INVALID");
  }
  return value;
}

async function main(): Promise<void> {
  const evidencePath = process.env["WORKER_ACCEPTANCE_EVIDENCE_PATH"]?.trim()
    || `worker-horizontal-acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const evidence: Record<string, unknown> = {
    schema: "supacloud.worker-horizontal-acceptance.v1",
    startedAt: new Date().toISOString(),
    platform: process.platform,
    status: "FAIL",
  };
  try {
    if (process.platform !== "linux") throw new Error("WORKER_ACCEPTANCE_LINUX_REQUIRED");
    const target = required("WORKER_ACCEPTANCE_TARGET_URL");
    const candidate = required("WORKER_ACCEPTANCE_CANDIDATE");
    const hardware = required("WORKER_ACCEPTANCE_HARDWARE");
    const workload = required("WORKER_ACCEPTANCE_WORKLOAD");
    const units = unitsFromEnvironment();
    const replicas = integer("WORKER_ACCEPTANCE_REPLICAS", 1, 1, 256);
    const shards = integer("WORKER_ACCEPTANCE_SHARDS", 1, 1, 256);
    if (units.length !== replicas * shards) throw new Error("WORKER_ACCEPTANCE_UNIT_COUNT_INVALID");
    const spec: WorkerLoadSpec = {
      durationMs: integer("WORKER_ACCEPTANCE_DURATION_SECONDS", 10, 1, 86_400) * 1000,
      requestsPerSecond: number("WORKER_ACCEPTANCE_REQUESTS_PER_SECOND", 10, 0.1, 100_000),
      maxInFlight: integer("WORKER_ACCEPTANCE_MAX_IN_FLIGHT", 32, 1, 10_000),
      requestTimeoutMs: integer("WORKER_ACCEPTANCE_REQUEST_TIMEOUT_MS", 5000, 100, 120_000),
      p95Ms: number("WORKER_ACCEPTANCE_MAX_P95_MS", 500, 0.1, 120_000),
      p99Ms: number("WORKER_ACCEPTANCE_MAX_P99_MS", 1000, 0.1, 120_000),
      maxErrorRate: number("WORKER_ACCEPTANCE_MAX_ERROR_RATE", 0, 0, 1),
      maxLatencyRegression: number("WORKER_ACCEPTANCE_MAX_LATENCY_REGRESSION", 1, 0, 20),
      drainTimeoutMs: integer("WORKER_ACCEPTANCE_DRAIN_TIMEOUT_SECONDS", 600, 1, 86_400) * 1000,
    };
    if (process.env["WORKER_ACCEPTANCE_LONG_SOAK"] === "true" && spec.durationMs < 1_800_000) {
      throw new Error("WORKER_ACCEPTANCE_LONG_SOAK_REQUIRES_30_MINUTES");
    }
    const expected = {
      cpuLimit: number("WORKER_ACCEPTANCE_CPU_LIMIT", 0.5, 0.01, 64),
      memoryLimitMiB: integer("WORKER_ACCEPTANCE_MEMORY_LIMIT_MIB", 256, 16, 1_048_576),
    };
    const maxQueueAgeSeconds = number("WORKER_ACCEPTANCE_MAX_QUEUE_AGE_SECONDS", 120, 0, 86_400);
    const crash = parseJsonCommand(process.env["WORKER_ACCEPTANCE_CRASH_COMMAND"], "CRASH");
    const restart = parseJsonCommand(process.env["WORKER_ACCEPTANCE_RESTART_COMMAND"], "RESTART");
    const requestPath = process.env["WORKER_ACCEPTANCE_REQUEST_PATH"]?.trim() || "/acceptance/request";
    const startBatchPath = process.env["WORKER_ACCEPTANCE_START_BATCH_PATH"]?.trim() || "/acceptance/batch";
    const statusTemplate = process.env["WORKER_ACCEPTANCE_BATCH_STATUS_PATH"]?.trim() || "/acceptance/batch/{id}";
    const effectTemplate = process.env["WORKER_ACCEPTANCE_EFFECT_PATH"]?.trim() || "/acceptance/effect/{id}";
    let peakOldestQueueAgeSeconds = 0;
    const mixed = await acceptWorkerMixedLoad(spec, {
      request: async signal => {
        const response = await fetch(url(requestPath), {
          headers: { authorization: `Bearer ${required("WORKER_ACCEPTANCE_TOKEN")}`, accept: "application/json" },
          signal,
        });
        if (!response.ok) return false;
        const body: unknown = await response.json().catch(() => null);
        return !!body && typeof body === "object" && !Array.isArray(body) && (body as { ok?: unknown }).ok === true;
      },
      startBatch: async () => {
        const body = await jsonRequest(startBatchPath, { method: "POST", body: JSON.stringify({ durationSeconds: spec.durationMs / 1000, replicas, shards }) });
        if (typeof body["operationId"] !== "string" || !body["operationId"]) throw new Error("WORKER_ACCEPTANCE_BATCH_ID_INVALID");
        await command(crash);
        await command(restart);
        return body["operationId"];
      },
      batchComplete: async (operationId, signal) => {
        const response = await fetch(url(statusTemplate.replace("{id}", encodeURIComponent(operationId))), {
          headers: { authorization: `Bearer ${required("WORKER_ACCEPTANCE_TOKEN")}`, accept: "application/json" }, signal,
        });
        if (!response.ok) return false;
        const body: unknown = await response.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return false;
        const age = (body as { oldestQueueAgeSeconds?: unknown }).oldestQueueAgeSeconds;
        if (typeof age === "number" && Number.isFinite(age) && age >= 0) peakOldestQueueAgeSeconds = Math.max(peakOldestQueueAgeSeconds, age);
        return (body as { completed?: unknown }).completed === true;
      },
    });
    const effect = await jsonRequest(effectTemplate.replace("{id}", encodeURIComponent(mixed.batchOperationId)));
    if (effect["effectCount"] !== 1) throw new Error("WORKER_ACCEPTANCE_DUPLICATE_EFFECT");
    if (peakOldestQueueAgeSeconds > maxQueueAgeSeconds) throw new Error("WORKER_ACCEPTANCE_QUEUE_AGE_FAILED");
    const cgroups = await readCgroups(units, expected);
    if (cgroups.some(readback => !readback.passed)) throw new Error("WORKER_ACCEPTANCE_CGROUP_FAILED");
    evidence["target"] = target;
    evidence["candidate"] = candidate;
    evidence["hardware"] = hardware;
    evidence["workload"] = workload;
    evidence["replicas"] = replicas;
    evidence["shards"] = shards;
    evidence["units"] = units;
    evidence["spec"] = spec;
    evidence["mixedLoad"] = mixed;
    evidence["peakOldestQueueAgeSeconds"] = peakOldestQueueAgeSeconds;
    evidence["maxQueueAgeSeconds"] = maxQueueAgeSeconds;
    evidence["idempotentEffect"] = effect;
    evidence["cgroups"] = cgroups;
    evidence["status"] = mixed.passed ? "PASS" : "FAIL";
    if (!mixed.passed) throw new Error("WORKER_ACCEPTANCE_LOAD_GATE_FAILED");
  } catch (error) {
    evidence["error"] = error instanceof Error ? error.message : String(error);
  } finally {
    evidence["finishedAt"] = new Date().toISOString();
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
  }
  if (evidence["status"] !== "PASS") process.exitCode = 2;
}

if (import.meta.main) await main();
