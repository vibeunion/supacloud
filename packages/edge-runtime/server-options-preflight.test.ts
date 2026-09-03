import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

const PROJECT_REF = "preflightcontract";
const INTERNAL_TOKEN = "edge-runtime-preflight-test-token";
const SERVICE_ROLE_KEY = "edge-runtime-preflight-test-service-role";
const ALLOWED_ORIGIN = "https://app.example.com";

let fixtureRoot = "";
let projectRoot = "";
let edgeBaseUrl = "";
let managementServer: Bun.Server<undefined> | undefined;
let edgeProcess: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let edgeStdout: Promise<string> | undefined;
let edgeStderr: Promise<string> | undefined;

const CORS_GUARD_SOURCE = `
export default (req) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("origin");
    if (origin !== ${JSON.stringify(ALLOWED_ORIGIN)}) {
      return new Response(null, { status: 204, headers: { "x-preflight-handler": "function" } });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "x-preflight-handler": "function",
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization, x-fa-client, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": ${JSON.stringify(ALLOWED_ORIGIN)},
    },
  });
};
`;

function reserveEdgePort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  reservation.stop(true);
  return port;
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ConnectionRefused" || error.code === "ECONNREFUSED";
}

async function waitForEdgeRuntime(): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (edgeProcess?.exitCode !== null) break;
    try {
      if ((await fetch(`${edgeBaseUrl}/health`)).ok) return;
    } catch (error) {
      if (!isConnectionRefused(error)) throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error("Edge Runtime test server did not become healthy");
}

function startManagementServer(): Bun.Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({
      SUPACLOUD_AUTH_RUNTIME_MODE: "local",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    }, {
      headers: {
        "x-supacloud-runtime-env-revision": `hmac-sha256:${"e".repeat(64)}`,
      },
    }),
  });
}

function startEdgeRuntime(managementPort: number): void {
  const edgePort = reserveEdgePort();
  edgeBaseUrl = `http://127.0.0.1:${edgePort}`;
  edgeProcess = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "server.ts"),
  ], {
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      EDGE_RUNTIME_HOST: "127.0.0.1",
      EDGE_RUNTIME_PORT: String(edgePort),
      EDGE_RUNTIME_MASTER_KEY: INTERNAL_TOKEN,
      EDGE_FUNCTIONS_DIR: join(fixtureRoot, "functions"),
      EDGE_FUNCTIONS_BASE_DIR: join(fixtureRoot, "functions"),
      MANAGEMENT_API_URL: `http://127.0.0.1:${managementPort}`,
      TENANTS_DIR: join(fixtureRoot, "tenants"),
      WORKER_POOL_SIZE: "1",
      BACKGROUND_WORKER_POOL_SIZE: "1",
    },
  });
  edgeStdout = new Response(edgeProcess.stdout).text();
  edgeStderr = new Response(edgeProcess.stderr).text();
}

async function stopEdgeRuntime(): Promise<void> {
  if (!edgeProcess) return;
  if (edgeProcess.exitCode === null) edgeProcess.kill("SIGTERM");
  const timeout = Symbol("timeout");
  const exitCode = await Promise.race([
    edgeProcess.exited,
    Bun.sleep(3_000).then(() => timeout),
  ]);
  if (exitCode === timeout) {
    edgeProcess.kill("SIGKILL");
    await edgeProcess.exited;
  }
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(homedir(), ".supacloud-edge-preflight-contract-"));
  projectRoot = join(fixtureRoot, "functions", PROJECT_REF);
  await mkdir(projectRoot, { recursive: true });
  projectRoot = await realpath(projectRoot);
  managementServer = startManagementServer();
  startEdgeRuntime(managementServer.port);
  await waitForEdgeRuntime();
  await writeFile(join(projectRoot, "cors-guard.ts"), CORS_GUARD_SOURCE);
});

afterAll(async () => {
  await stopEdgeRuntime();
  managementServer?.stop(true);
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (edgeProcess && edgeProcess.exitCode !== 0) {
    console.warn("[edge stdout]", await edgeStdout);
    console.warn("[edge stderr]", await edgeStderr);
  }
});

describe("Edge Runtime OPTIONS preflight passthrough", () => {
  test("OPTIONS preflight reaches the function and returns its CORS policy verbatim", async () => {
    const response = await fetch(`${edgeBaseUrl}/functions/v1/cors-guard/cases`, {
      method: "OPTIONS",
      headers: {
        "x-project-ref": PROJECT_REF,
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, x-fa-client",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("x-preflight-handler")).toBe("function");
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization, x-fa-client, content-type");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  });

  test("function responses keep their own allow-origin over the platform default", async () => {
    const response = await fetch(`${edgeBaseUrl}/functions/v1/cors-guard`, {
      headers: {
        "x-project-ref": PROJECT_REF,
        apikey: SERVICE_ROLE_KEY,
        origin: "https://other.example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });
});
