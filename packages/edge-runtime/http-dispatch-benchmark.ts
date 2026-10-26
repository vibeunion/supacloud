/**
 * End-to-end HTTP dispatch benchmark.
 *
 * Boots the real Edge Runtime entrypoint against a temporary project fixture and
 * measures completed function invocations over HTTP, so the numbers include
 * routing, JWT/throttle bookkeeping, attestation, queueing and response
 * delivery instead of only Worker-pool dispatch.
 *
 *   bun http-dispatch-benchmark.ts --concurrency 16 --requests 20000
 *
 * The fixture function is written to a temporary directory; nothing is left
 * behind. Use `--io` to add an awaited delay to the handler so queueing costs can
 * be separated from transport and bookkeeping costs.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_REF = "httpbench";
const INTERNAL_TOKEN = "http-dispatch-benchmark-master-key";
const SERVICE_ROLE_KEY = "http-dispatch-benchmark-service-role";

type BenchmarkOptions = {
  size: number;
  concurrency: number;
  requests: number;
  ioMs: number;
  responseBytes: number;
  entrypoint: string;
};

function parseOptions(argv: string[]): BenchmarkOptions {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags.set(flag.slice(2), "true");
    else {
      flags.set(flag.slice(2), next);
      index += 1;
    }
  }
  const number = (name: string, fallback: number) => {
    const raw = flags.get(name);
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    size: Math.max(1, number("size", 4)),
    concurrency: Math.max(1, number("concurrency", 16)),
    requests: Math.max(1, number("requests", 20_000)),
    ioMs: number("io", 0),
    responseBytes: number("response-bytes", 0),
    entrypoint: flags.get("entrypoint") ?? join(import.meta.dir, "server.ts"),
  };
}

function functionSource(options: BenchmarkOptions): string {
  return `export default async (req) => {
  const url = new URL(req.url);
  const requested = Number(url.searchParams.get("io") ?? 0);
  if (Number.isFinite(requested) && requested > 0) await Bun.sleep(requested);
  const bytes = Number(url.searchParams.get("bytes") ?? 0);
  const headers = { "content-type": "application/json" };
  if (Number.isFinite(bytes) && bytes > 0) {
    return new Response(new Uint8Array(bytes).fill(97), { headers: { "content-type": "text/plain" } });
  }
  return new Response(JSON.stringify({ ok: true, path: url.pathname }), { headers });
};
`;
}

export async function benchmarkHttpDispatch(options: BenchmarkOptions) {
  const fixtureRoot = await mkdtemp(join(homedir(), ".supacloud-edge-http-bench-"));
  const functionsDir = join(fixtureRoot, "functions");
  const projectRoot = join(functionsDir, PROJECT_REF);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "bench.ts"), functionSource(options));

  const management = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({
      SUPACLOUD_AUTH_RUNTIME_MODE: "local",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    }, {
      headers: { "x-supacloud-runtime-env-revision": `hmac-sha256:${"e".repeat(64)}` },
    }),
  });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  reservation.stop(true);
  const baseUrl = `http://127.0.0.1:${port}`;

  const stderr = join(tmpdir(), `supacloud-edge-http-bench-${process.pid}.log`);
  const runtime = Bun.spawn([process.execPath, options.entrypoint], {
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(stderr),
    env: {
      ...process.env,
      EDGE_RUNTIME_HOST: "127.0.0.1",
      EDGE_RUNTIME_PORT: String(port),
      EDGE_RUNTIME_MASTER_KEY: INTERNAL_TOKEN,
      EDGE_FUNCTIONS_DIR: functionsDir,
      EDGE_FUNCTIONS_BASE_DIR: functionsDir,
      MANAGEMENT_API_URL: `http://127.0.0.1:${management.port}`,
      TENANTS_DIR: join(fixtureRoot, "tenants"),
      WORKER_POOL_SIZE: String(options.size),
      BACKGROUND_WORKER_POOL_SIZE: "1",
      MAX_QUEUE_SIZE: String(Math.max(512, options.concurrency * 8)),
      NODE_ENV: "production",
    },
  });

  const query = `io=${options.ioMs}&bytes=${options.responseBytes}`;
  const invoke = async () => {
    const response = await fetch(`${baseUrl}/functions/v1/bench?${query}`, {
      headers: { "x-project-ref": PROJECT_REF, apikey: SERVICE_ROLE_KEY },
    });
    const body = await response.arrayBuffer();
    if (response.status !== 200) throw new Error(`dispatch failed with ${response.status}`);
    return body.byteLength;
  };

  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline || runtime.exitCode !== null) {
        throw new Error(`Edge Runtime did not become healthy; see ${stderr}`);
      }
      await Bun.sleep(25);
    }

    for (let index = 0; index < 200; index += 1) await invoke();

    const latencies: number[] = [];
    let dispatched = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      while (dispatched < options.requests) {
        dispatched += 1;
        const requestStart = performance.now();
        await invoke();
        latencies.push(performance.now() - requestStart);
      }
    }));
    const elapsedMs = performance.now() - started;
    latencies.sort((a, b) => a - b);
    const percentile = (fraction: number) =>
      latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] ?? 0;

    return {
      ...options,
      requests: options.requests,
      elapsedMs: Math.round(elapsedMs),
      requestsPerSecond: Math.round(options.requests * 1000 / elapsedMs),
      p50Ms: Number(percentile(0.5).toFixed(3)),
      p90Ms: Number(percentile(0.9).toFixed(3)),
      p99Ms: Number(percentile(0.99).toFixed(3)),
      maxMs: Number((latencies.at(-1) ?? 0).toFixed(3)),
    };
  } finally {
    runtime.kill("SIGTERM");
    await Promise.race([runtime.exited, Bun.sleep(5_000).then(() => runtime.kill("SIGKILL"))]);
    management.stop(true);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stderr, { force: true });
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await benchmarkHttpDispatch(parseOptions(process.argv.slice(2)))));
}