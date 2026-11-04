import { cpus, arch, platform, release } from "node:os";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(root, "server.mjs");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const HOST = "127.0.0.1";

const options = parseOptions(process.argv.slice(2));
const requests = positiveInteger(options.requests, 10_000, "requests");
const rounds = positiveInteger(options.rounds, 5, "rounds");
const concurrency = positiveInteger(options.concurrency, 32, "concurrency");
const warmup = positiveInteger(options.warmup, Math.min(1_000, requests), "warmup");
const requestIdMode = options["request-id-mode"] ?? "provided";
if (requestIdMode !== "provided" && requestIdMode !== "generated") {
  throw new Error("request-id-mode must be provided or generated");
}
const output = options.output ? resolve(process.cwd(), options.output) : undefined;
const allAdapters = [
  { id: "supacloud-elysia-bun", label: "SupaCloud compiled adapter / Elysia 2 / Bun (compiler-selected plan)", runtime: "bun", validation: "TypeBox native route schema" },
  { id: "express", label: "Express", runtime: "node", validation: "TypeBox Value.Check middleware" },
  { id: "fastify", label: "Fastify", runtime: "node", validation: "TypeBox JSON Schema / Ajv" },
  { id: "nestjs-express", label: "NestJS / Express", runtime: "node", validation: "TypeBox pipe" },
  { id: "nestjs-node", label: "NestJS / native Node", runtime: "node", validation: "TypeBox pipe" },
  { id: "elysia-native-contract-bun", label: "Elysia 2 native / same contracts / Bun", runtime: "bun", validation: "TypeBox native route schema" },
  { id: "elysia-native-bare-bun", label: "Elysia 2 native bare baseline / Bun", runtime: "bun", validation: "none" },
];
const only = options.only === undefined ? undefined : String(options.only).split(",").filter(Boolean);
const adapters = only === undefined ? allAdapters : allAdapters.filter((adapter) => only.includes(adapter.id));
if (adapters.length === 0) throw new Error("--only did not select a known adapter");
const scenarios = [
  { id: "static-json", method: "GET", path: "/json", body: undefined, expected: { ok: true, value: 42 } },
  { id: "path-params", method: "GET", path: "/params/benchmark", body: undefined, expected: { ok: true, id: "benchmark" } },
  {
    id: "json-body",
    method: "POST",
    path: "/echo",
    body: JSON.stringify({ value: 42, label: "benchmark" }),
    expected: { ok: true, value: 42, label: "benchmark" },
  },
];

const resultRows = [];
const observedAdapters = new Map();
for (let adapterOffset = 0; adapterOffset < adapters.length; adapterOffset += 1) {
  const adapter = adapters[adapterOffset];
  const processInfo = await startServer(adapter);
  observedAdapters.set(adapter.id, processInfo.event);
  try {
    for (let scenarioOffset = 0; scenarioOffset < scenarios.length; scenarioOffset += 1) {
      const scenario = scenarios[(scenarioOffset + adapterOffset) % scenarios.length];
      const url = `http://${HOST}:${processInfo.port}${scenario.path}`;
      await load(url, scenario, warmup, concurrency, false, requestIdMode);
      const samples = [];
      for (let round = 0; round < rounds; round += 1) {
        const sample = await load(url, scenario, requests, concurrency, true, requestIdMode);
        samples.push({ round, ...sample });
      }
      resultRows.push({
        adapter: adapter.id,
        scenario: scenario.id,
        samples,
        summary: summarize(samples),
      });
    }
  } finally {
    await stopServer(processInfo.child);
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  git: {
    sha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF_NAME ?? null,
    releaseTag: process.env.GITHUB_REF_NAME ?? null,
  },
  host: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
  },
  configuration: { requests, rounds, concurrency, warmup, requestIdMode },
  client: { runtime: `node ${process.versions.node}`, implementation: "native fetch" },
  dependencies: packageJson.dependencies,
  adapters: adapters.map((adapter) => ({ ...adapter, observed: observedAdapters.get(adapter.id) ?? null })),
  results: resultRows,
  comparisons: buildComparisons(resultRows),
  methodology: "Each adapter runs in an isolated child process. The same native fetch client, loopback address, response contract, warmup, concurrency, request-id mode and rotated scenario order are used for every adapter. The provided request-id mode models the Edge Runtime header; generated mode measures the fallback UUID path. Throughput and latency include client transport and JSON handling; server startup time is excluded. These are relative framework overhead measurements, not production capacity or an SLA.",
};

const json = JSON.stringify(report, null, 2) + "\n";
const markdown = renderMarkdown(report);
if (output) {
  await writeFile(output, json);
  await writeFile(output.replace(/\.json$/i, ".md"), markdown);
} else {
  process.stdout.write(json);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
}
const totalErrors = resultRows.reduce((sum, row) => sum + row.summary.errorCount, 0);
if (totalErrors > 0) {
  throw new Error(`Benchmark response contract failed: ${totalErrors} errors`);
}

function parseOptions(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unknown argument: ${value}`);
    const key = value.slice(2);
    parsed[key] = values[index + 1] ?? true;
    index += 1;
  }
  return parsed;
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function commandFor(adapter) {
  return adapter.runtime === "bun" ? (process.env.BUN_BIN ?? "bun") : process.execPath;
}

async function startServer(adapter) {
  const port = await freePort();
  const child = spawn(commandFor(adapter), [serverPath, "--adapter", adapter.id, "--port", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`Timed out starting ${adapter.id}\n${stdout}\n${stderr}`)), 30_000);
    const onLine = (line) => {
      stdout = `${stdout}${line}\n`.slice(-8_000);
      try {
        const event = JSON.parse(line);
        if (event.event !== "ready") return;
        clearTimeout(timer);
        resolveReady(event);
      } catch {
        // Keep non-JSON startup output for diagnostics.
      }
    };
    child.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) onLine(line);
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
    child.once("exit", (code, signal) => {
      if (code !== 0) rejectReady(new Error(`${adapter.id} exited before ready: ${code ?? signal}\n${stdout}\n${stderr}`));
    });
  });
  const event = await ready.catch(async (error) => {
    child.kill("SIGTERM");
    await waitForExit(child);
    throw error;
  });
  return { child, port, event };
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    waitForExit(child),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out stopping benchmark server")), 10_000)),
  ]);
}

async function load(url, scenario, count, workerCount, measure, requestIdMode) {
  let next = 0;
  let errors = 0;
  const latencies = measure ? new Float64Array(count) : undefined;
  const startedAt = performance.now();
  const workers = Array.from({ length: Math.min(workerCount, count) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      const started = performance.now();
      try {
        const headers = scenario.body === undefined ? {} : { "content-type": "application/json" };
        if (requestIdMode === "provided") headers["x-request-id"] = `bench-${index}`;
        const response = await fetch(url, {
          method: scenario.method,
          headers,
          body: scenario.body,
        });
        const payload = await response.json();
        if (response.status !== 200 || !samePayload(payload, scenario.expected)) errors += 1;
      } catch {
        errors += 1;
      } finally {
        if (latencies) latencies[index] = performance.now() - started;
      }
    }
  });
  await Promise.all(workers);
  if (!measure) return { errors };
  const sorted = [...latencies].sort((left, right) => left - right);
  const elapsedMs = performance.now() - startedAt;
  return {
    requests: count,
    errors,
    errorRate: errors / count,
    requestsPerSecond: count / Math.max(1, elapsedMs) * 1000,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HOST, port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Unable to allocate a benchmark port");
  return port;
}

function samePayload(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(samples) {
  return {
    requestsPerSecondMedian: median(samples.map((sample) => sample.requestsPerSecond)),
    p50MsMedian: median(samples.map((sample) => sample.p50Ms)),
    p95MsMedian: median(samples.map((sample) => sample.p95Ms)),
    p99MsMedian: median(samples.map((sample) => sample.p99Ms)),
    errorCount: samples.reduce((sum, sample) => sum + sample.errors, 0),
  };
}

function buildComparisons(rows) {
  return scenarios.map((scenario) => {
    const forScenario = rows.filter((row) => row.scenario === scenario.id);
    const supacloud = forScenario.find((row) => row.adapter === "supacloud-elysia-bun")?.summary;
    const nativeElysia = forScenario.find((row) => row.adapter === "elysia-native-contract-bun")?.summary;
    const nativeBareElysia = forScenario.find((row) => row.adapter === "elysia-native-bare-bun")?.summary;
    const native = forScenario.filter((row) => !["supacloud-elysia-bun", "elysia-native-contract-bun", "elysia-native-bare-bun"].includes(row.adapter));
    const fastestNative = native.reduce((best, row) => !best || row.summary.requestsPerSecondMedian > best.summary.requestsPerSecondMedian ? row : best, undefined);
    return {
      scenario: scenario.id,
      supacloudVsNativeElysia: comparison(supacloud, nativeElysia),
      supacloudVsNativeElysiaBare: comparison(supacloud, nativeBareElysia),
      supacloudVsFastestNative: comparison(supacloud, fastestNative?.summary),
      fastestNativeAdapter: fastestNative?.adapter ?? null,
    };
  });
}

function comparison(left, right) {
  if (!left || !right) return null;
  return {
    requestsPerSecondDeltaPercent: (left.requestsPerSecondMedian / right.requestsPerSecondMedian - 1) * 100,
    p95DeltaPercent: (left.p95MsMedian / right.p95MsMedian - 1) * 100,
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Framework comparison benchmark",
    "",
    `Generated: ${report.generatedAt} · Node fetch client · ${report.host.platform}/${report.host.arch}`,
    "",
    `Configuration: ${report.configuration.requests} requests × ${report.configuration.rounds} rounds, concurrency ${report.configuration.concurrency}, warmup ${report.configuration.warmup}; SupaCloud uses compiler-generated positional invokers.`,
    "",
    "Values are medians of round-level measurements. Lower latency is better; higher throughput is better.",
    "",
  ];
  for (const scenario of scenarios) {
    lines.push(`## ${scenario.id}`, "", "| Adapter | Validation | Requests/s | P50 ms | P95 ms | P99 ms | Errors |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const row of report.results.filter((item) => item.scenario === scenario.id).sort((left, right) => right.summary.requestsPerSecondMedian - left.summary.requestsPerSecondMedian)) {
      const adapter = report.adapters.find((item) => item.id === row.adapter);
      lines.push(`| ${adapter?.label ?? row.adapter} | ${adapter?.validation ?? "-"} | ${format(row.summary.requestsPerSecondMedian)} | ${format(row.summary.p50MsMedian)} | ${format(row.summary.p95MsMedian)} | ${format(row.summary.p99MsMedian)} | ${row.summary.errorCount} |`);
    }
    const comparison = report.comparisons.find((item) => item.scenario === scenario.id);
    if (comparison?.supacloudVsNativeElysia && comparison.supacloudVsNativeElysiaBare && comparison.supacloudVsFastestNative) {
      lines.push(
        "",
        `SupaCloud vs native Elysia with the same contracts: RPS ${signed(comparison.supacloudVsNativeElysia.requestsPerSecondDeltaPercent)}%, P95 ${signed(comparison.supacloudVsNativeElysia.p95DeltaPercent)}%; vs bare Elysia: RPS ${signed(comparison.supacloudVsNativeElysiaBare.requestsPerSecondDeltaPercent)}%, P95 ${signed(comparison.supacloudVsNativeElysiaBare.p95DeltaPercent)}%; vs fastest native (${comparison.fastestNativeAdapter}): RPS ${signed(comparison.supacloudVsFastestNative.requestsPerSecondDeltaPercent)}%, P95 ${signed(comparison.supacloudVsFastestNative.p95DeltaPercent)}%.`,
      );
    }
    lines.push("");
  }
  lines.push("The benchmark measures relative loopback framework overhead. It does not model database, network, TLS, authentication, logging, or production concurrency.", "");
  return lines.join("\n");
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "-";
}

function signed(value) {
  return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}` : "-";
}
