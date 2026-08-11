import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

const PROJECT_REF = "configcontract";
const INTERNAL_TOKEN = "edge-runtime-config-test-token";
const SERVICE_ROLE_KEY = "edge-runtime-config-test-service-role";

let fixtureRoot = "";
let projectRoot = "";
let edgeBaseUrl = "";
let managementServer: Bun.Server<undefined> | undefined;
let edgeProcess: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let edgeStdout: Promise<string> | undefined;
let edgeStderr: Promise<string> | undefined;

function functionSource(body: string): string {
  return `export default () => new Response(${JSON.stringify(body)});\n`;
}

async function writeLegacyFunction(slug: string, body: string): Promise<void> {
  await writeFile(join(projectRoot, `${slug}.ts`), functionSource(body));
}

async function writeVersionedFunction(
  slug: string,
  version: string,
  body: string,
): Promise<void> {
  const versionRoot = join(projectRoot, ".versions", slug, version);
  await mkdir(versionRoot, { recursive: true });
  await writeFile(join(versionRoot, "index.js"), functionSource(body));
}

async function writeFunctionConfig(slug: string, raw: string): Promise<void> {
  await writeFile(join(projectRoot, `${slug}.config.json`), raw);
}

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

async function invokeForeground(slug: string): Promise<Response> {
  return fetch(`${edgeBaseUrl}/functions/v1/${slug}`, {
    headers: {
      "x-project-ref": PROJECT_REF,
      apikey: SERVICE_ROLE_KEY,
    },
  });
}

type BackgroundEnvelope = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

async function invokeBackground(slug: string): Promise<BackgroundEnvelope> {
  const response = await fetch(`${edgeBaseUrl}/internal/background/${PROJECT_REF}/${slug}`, {
    method: "POST",
    headers: { "x-supacloud-internal-auth": `Bearer ${INTERNAL_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<BackgroundEnvelope>;
}

async function invalidateFunctionConfig(slug: string): Promise<void> {
  const response = await fetch(`${edgeBaseUrl}/invalidate/${PROJECT_REF}/${slug}`, {
    method: "POST",
    headers: { "x-supacloud-internal-auth": `Bearer ${INTERNAL_TOKEN}` },
  });
  expect(response.status).toBe(200);
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

function startManagementServer(): Bun.Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({
      SUPACLOUD_AUTH_RUNTIME_MODE: "local",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    }),
  });
}

function edgeRuntimeEnvironment(
  edgePort: number,
  managementPort: number,
): Record<string, string | undefined> {
  return {
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
  };
}

function startEdgeRuntime(managementPort: number): void {
  const edgePort = reserveEdgePort();
  edgeBaseUrl = `http://127.0.0.1:${edgePort}`;
  edgeProcess = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: edgeRuntimeEnvironment(edgePort, managementPort),
  });
  edgeStdout = new Response(edgeProcess.stdout).text();
  edgeStderr = new Response(edgeProcess.stderr).text();
}

async function initializeServerFixture(): Promise<void> {
  fixtureRoot = await mkdtemp(join(tmpdir(), "supacloud-edge-config-contract-"));
  projectRoot = join(fixtureRoot, "functions", PROJECT_REF);
  await mkdir(projectRoot, { recursive: true });
  managementServer = startManagementServer();
  startEdgeRuntime(managementServer.port);
  await waitForEdgeRuntime();
}

async function expectInvalidConfigFailsClosed(slug: string, rawConfig: string): Promise<void> {
  const staleBody = `stale-${slug}`;
  await writeLegacyFunction(slug, staleBody);
  await writeFunctionConfig(slug, rawConfig);

  const foreground = await invokeForeground(slug);
  expect(foreground.status).toBe(500);
  expect(foreground.headers.has("x-supacloud-function-version")).toBe(false);
  expect(await foreground.text()).not.toContain(staleBody);

  const background = await invokeBackground(slug);
  expect(background.status).toBe(500);
  expect(background.headers["x-supacloud-function-version"]).toBeUndefined();
  expect(background.bodyText).not.toContain(staleBody);
}

async function installValidFunction(
  slug: string,
  version: string | null,
  body: string,
): Promise<void> {
  if (version === null) {
    await writeLegacyFunction(slug, body);
    return;
  }
  await writeVersionedFunction(slug, version, body);
  await writeFunctionConfig(slug, JSON.stringify({ verify_jwt: false, version }));
}

async function expectValidFunctionResponse(
  slug: string,
  body: string,
  responseVersion: string | null,
): Promise<void> {
  const foreground = await invokeForeground(slug);
  expect(foreground.status).toBe(200);
  expect(foreground.headers.get("x-supacloud-function-version")).toBe(responseVersion);
  expect(await foreground.text()).toBe(body);

  const background = await invokeBackground(slug);
  expect(background.status).toBe(200);
  expect(background.headers["x-supacloud-function-version"] ?? null).toBe(responseVersion);
  expect(background.bodyText).toBe(body);
}

beforeAll(initializeServerFixture);

afterAll(async () => {
  await stopEdgeRuntime();
  managementServer?.stop(true);
  await Promise.all([edgeStdout, edgeStderr]);
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe("Edge Runtime function config boundary", () => {
  test("fails closed for malformed config without executing stale aliases", async () => {
    const invalidConfigs = [
      ["numeric", '{"verify_jwt":false,"version":1}'],
      ["malformed", "{"],
      ["array", "[]"],
      ["null", "null"],
      ["empty", '{"verify_jwt":false,"version":""}'],
      ["leading_zero", '{"verify_jwt":false,"version":"01"}'],
      ["unsafe", '{"verify_jwt":false,"version":"9007199254740992"}'],
    ] as const;

    for (const [slug, rawConfig] of invalidConfigs) {
      await expectInvalidConfigFailsClosed(slug, rawConfig);
    }
  });

  test("serves only the configured manifest-less, v0, and positive artifacts", async () => {
    const fixtures = [
      ["legacy", null, "legacy-body", null],
      ["legacy_zero", "0", "legacy-zero-body", null],
      ["positive", "7", "positive-body", "7"],
    ] as const;

    for (const [slug, version, body, responseVersion] of fixtures) {
      await installValidFunction(slug, version, body);
      await expectValidFunctionResponse(slug, body, responseVersion);
    }
  });

  test("does not cache invalid config as a manifest-less activation", async () => {
    const slug = "cache_recovery";
    await writeLegacyFunction(slug, "stale-cache-alias");
    await writeFunctionConfig(slug, '{"verify_jwt":false,"version":1}');
    expect((await invokeForeground(slug)).status).toBe(500);

    await writeVersionedFunction(slug, "3", "immutable-v3");
    await writeFunctionConfig(slug, '{"verify_jwt":false,"version":"3"}');
    const recovered = await invokeForeground(slug);
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("x-supacloud-function-version")).toBe("3");
    expect(await recovered.text()).toBe("immutable-v3");

    await writeFunctionConfig(slug, '{"verify_jwt":false,"version":"01"}');
    await invalidateFunctionConfig(slug);
    const invalidated = await invokeForeground(slug);
    expect(invalidated.status).toBe(500);
    expect(await invalidated.text()).not.toContain("stale-cache-alias");
  });
});
