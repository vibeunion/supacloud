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
let defaultBaseUrl = "";
let managementServer: Bun.Server<undefined> | undefined;
interface TestRuntime {
  baseUrl: string;
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  stdout: Promise<string>;
  stderr: Promise<string>;
}
const runtimes: TestRuntime[] = [];

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
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "x-function-header",
    },
  });
};
`;

const NO_CORS_SOURCE = `
export default () => new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: { "content-type": "application/json" },
});
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

async function waitForEdgeRuntime(runtime: TestRuntime): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (runtime.process.exitCode !== null) break;
    try {
      if ((await fetch(`${runtime.baseUrl}/health`)).ok) return;
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

function startEdgeRuntime(managementPort: number, corsMode = ""): TestRuntime {
  const edgePort = reserveEdgePort();
  const edgeProcess = Bun.spawn([
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
      EDGE_FUNCTIONS_CORS_MODE: corsMode,
    },
  });
  const runtime = {
    baseUrl: `http://127.0.0.1:${edgePort}`,
    process: edgeProcess,
    stdout: new Response(edgeProcess.stdout).text(),
    stderr: new Response(edgeProcess.stderr).text(),
  };
  runtimes.push(runtime);
  return runtime;
}

async function stopEdgeRuntime(runtime: TestRuntime): Promise<void> {
  const edgeProcess = runtime.process;
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
  await writeFile(join(projectRoot, "cors-guard.ts"), CORS_GUARD_SOURCE);
  await writeFile(join(projectRoot, "no-cors.ts"), NO_CORS_SOURCE);
  const permissiveRuntime = startEdgeRuntime(managementServer.port, "permissive");
  edgeBaseUrl = permissiveRuntime.baseUrl;
  await waitForEdgeRuntime(permissiveRuntime);
  const defaultRuntime = startEdgeRuntime(managementServer.port);
  defaultBaseUrl = defaultRuntime.baseUrl;
  await waitForEdgeRuntime(defaultRuntime);
});

afterAll(async () => {
  for (const runtime of runtimes) {
    await stopEdgeRuntime(runtime);
    if (runtime.process.exitCode !== 0) {
      console.warn("[edge stdout]", await runtime.stdout);
      console.warn("[edge stderr]", await runtime.stderr);
    }
  }
  managementServer?.stop(true);
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe("Edge Runtime default Function-owned CORS", () => {
  test("preserves a Function's explicit preflight policy", async () => {
    const response = await fetch(`${defaultBaseUrl}/functions/v1/cors-guard/cases`, {
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

  test("does not grant an origin rejected by the Function", async () => {
    const response = await fetch(`${defaultBaseUrl}/functions/v1/cors-guard`, {
      method: "OPTIONS",
      headers: { "x-project-ref": PROJECT_REF, origin: "https://other.example.com" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-preflight-handler")).toBe("function");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("preserves explicit actual response headers", async () => {
    const response = await fetch(`${defaultBaseUrl}/functions/v1/cors-guard`, {
      headers: { "x-project-ref": PROJECT_REF, apikey: SERVICE_ROLE_KEY },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-expose-headers")).toBe("x-function-header");
  });

  test("does not add CORS headers to a Function without them", async () => {
    const response = await fetch(`${defaultBaseUrl}/functions/v1/no-cors`, {
      headers: { "x-project-ref": PROJECT_REF, apikey: SERVICE_ROLE_KEY },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("Edge Runtime permissive Function CORS", () => {
  test("OPTIONS preflight is handled before function dispatch", async () => {
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
    expect(response.headers.get("x-preflight-handler")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization, x-fa-client");
    expect(response.headers.get("access-control-allow-methods")).toContain("OPTIONS");
  });

  test("allows an arbitrary origin in preflight", async () => {
    const response = await fetch(`${edgeBaseUrl}/functions/v1/cors-guard/cases`, {
      method: "OPTIONS",
      headers: {
        "x-project-ref": PROJECT_REF,
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, x-fa-client",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("OPTIONS");
  });

  test("overrides restrictive origins but preserves custom exposed headers", async () => {
    const response = await fetch(`${edgeBaseUrl}/functions/v1/cors-guard`, {
      headers: {
        "x-project-ref": PROJECT_REF,
        apikey: SERVICE_ROLE_KEY,
        origin: "https://other.example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toContain("x-function-header");
    expect(response.headers.get("access-control-expose-headers")).toContain("content-disposition");
  });

  test("adds wildcard CORS to a Function response without CORS headers", async () => {
    const response = await fetch(`${edgeBaseUrl}/functions/v1/no-cors`, {
      headers: {
        "x-project-ref": PROJECT_REF,
        apikey: SERVICE_ROLE_KEY,
        origin: "https://other.example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("handles preflight for a Function without OPTIONS handling", async () => {
    const response = await fetch(`${edgeBaseUrl}/functions/v1/no-cors`, {
      method: "OPTIONS",
      headers: {
        "x-project-ref": PROJECT_REF,
        origin: "null",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization, x-custom-client",
      },
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization, x-custom-client");
    expect(response.headers.get("vary")).toContain("Access-Control-Request-Headers");
  });

  test("does not bypass authentication on actual requests", async () => {
    const response = await fetch(`${edgeBaseUrl}/functions/v1/no-cors`, {
      headers: { "x-project-ref": PROJECT_REF, origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ msg: "Invalid JWT" });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("preserves routing errors rather than treating unknown Functions as successful preflights", async () => {
    const response = await fetch(`${edgeBaseUrl}/functions/v1/missing`, {
      method: "OPTIONS",
      headers: { "x-project-ref": PROJECT_REF, origin: ALLOWED_ORIGIN },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("does not apply permissive CORS to internal control routes", async () => {
    const response = await fetch(`${edgeBaseUrl}/metrics`, {
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
