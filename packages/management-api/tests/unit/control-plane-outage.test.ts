/**
 * @supacloud-test-isolate
 *
 * Local control-plane outage drill. Caddy v2 serves the gateway routes that
 * setupUpstream publishes. PostgREST and GoTrue are JWT-verifying stand-ins on
 * the published dials. Edge Runtime and the storage data plane are the real
 * processes. Backup RPO and RTO are not measured here.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../../src/config";
import { CaddyGatewayProvider } from "../../src/services/gateway.service";

setDefaultTimeout(120_000);

const PROJECT_REF = "outageproj";
const JWT_SECRET = "control-plane-outage-drill-jwt-secret";
function resolveCaddyBin(): string | null {
    const fromEnv = process.env.CADDY_BIN;
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
    return Bun.which("caddy");
}
const PGRST_PORT = 18111;
const GOTRUE_PORT = 18112;
const REQUESTS = 10;

const children: Bun.Subprocess[] = [];
let gateway: Bun.Server<undefined> | undefined;
let caddy: Bun.Subprocess | undefined;
let fixtureRoot = "";

function captureFetch(calls: Array<{ url: string; method: string; body: unknown }>): () => void {
    const originalFetch = globalThis.fetch;
    let loadedConfig: unknown = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method || "GET";
        let body: unknown = null;
        if (typeof init?.body === "string" && init.body.length > 0) {
            try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        calls.push({ url, method, body });
        if (method === "POST" && url.endsWith("/load")) loadedConfig = body;
        if (method === "GET" && url.endsWith("/config/")) return Response.json(loadedConfig ?? {});
        return new Response(JSON.stringify({ id: "cert_123", data: [] }));
    }) as typeof fetch;
    return () => { globalThis.fetch = originalFetch; };
}

function routeById(routes: Array<Record<string, unknown>>, id: string): Record<string, unknown> {
    const route = routes.find((candidate) => candidate["@id"] === id);
    if (!route) throw new Error(`missing gateway route ${id}`);
    return route;
}

function dialPort(route: Record<string, unknown>, index: number): number {
    const proxy = (route["handle"] as Array<Record<string, unknown>>)
        .find((handler) => handler["handler"] === "reverse_proxy");
    const upstreams = proxy?.["upstreams"] as Array<{ dial: string }> | undefined;
    const dial = upstreams?.[index]?.dial;
    const port = Number(dial?.split(":").at(-1));
    if (!Number.isInteger(port)) throw new Error(`missing dial ${index} on ${String(route["@id"])}`);
    return port;
}

async function waitForHttp(url: string): Promise<void> {
    const started = performance.now();
    while (performance.now() - started < 30_000) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(500) });
            if (response.ok) return;
        } catch {
            // process still binding
        }
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${url}`);
}

async function signedUserJwt(): Promise<string> {
    return await new SignJWT({ role: "authenticated", sub: "outage-user" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode(JWT_SECRET));
}

function jwtUpstream(plane: string): (request: Request) => Promise<Response> {
    return async (request) => {
        const header = request.headers.get("authorization") || "";
        const token = header.replace(/^Bearer\s+/i, "").trim();
        try {
            const verified = await jwtVerify(token, new TextEncoder().encode(JWT_SECRET), {
                algorithms: ["HS256"],
            });
            if (verified.payload.role !== "authenticated") {
                return Response.json({ message: "forbidden" }, { status: 403 });
            }
        } catch {
            return Response.json({ message: "invalid jwt" }, { status: 401 });
        }
        return Response.json({ ok: true, plane });
    };
}

async function curl(input: {
    host: string;
    port: number;
    path: string;
    method?: string;
    token?: string;
    body?: string;
    contentType?: string;
}): Promise<{ status: number; body: string; latencyMs: number }> {
    const args = [
        "-sS",
        "--resolve", `${input.host}:${input.port}:127.0.0.1`,
        "--max-time", "20",
        "-o", "-",
        "-w", "\n%{http_code} %{time_total}",
        "-X", input.method || "GET",
        "-H", `Authorization: Bearer ${input.token || "test-token"}`,
    ];
    if (input.body !== undefined) {
        args.push("-H", `content-type: ${input.contentType || "application/json"}`, "--data", input.body);
    }
    args.push(`http://${input.host}:${input.port}${input.path}`);
    const result = Bun.spawn(["curl", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(result.stdout).text(),
        new Response(result.stderr).text(),
        result.exited,
    ]);
    if (exitCode !== 0) throw new Error(`curl ${input.path} failed: ${stderr || stdout}`);
    const match = stdout.match(/\n(\d{3}) ([0-9.]+)$/);
    if (!match) throw new Error(`curl ${input.path} returned no status: ${stdout}`);
    return {
        status: Number(match[1]),
        body: stdout.slice(0, match.index),
        latencyMs: Number(match[2]) * 1000,
    };
}

function summary(samples: Array<{ status: number; latencyMs: number }>): {
    requests: number;
    success: number;
    latency_ms: { min: number; max: number; p50: number };
} {
    const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
    const mid = latencies[Math.floor((latencies.length - 1) / 2)] ?? 0;
    return {
        requests: samples.length,
        success: samples.filter((sample) => sample.status === 200).length,
        latency_ms: {
            min: Math.round(latencies[0] ?? 0),
            max: Math.round(latencies.at(-1) ?? 0),
            p50: Math.round(mid),
        },
    };
}

afterAll(async () => {
    gateway?.stop(true);
    caddy?.kill("SIGTERM");
    for (const child of children) {
        if (child.exitCode === null) child.kill("SIGTERM");
    }
    await Promise.all(children.map((child) => child.exited.catch(() => undefined)));
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

test("authenticated data-plane routes survive a closed Management API listener", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const restoreFetch = captureFetch(calls);
    let routes: Array<Record<string, unknown>>;
    try {
        const provider = new CaddyGatewayProvider();
        const setup = await provider.setupUpstream(PROJECT_REF, PGRST_PORT, GOTRUE_PORT);
        expect(setup.success).toBe(true);
        const load = calls.filter((call) => call.method === "POST" && String(call.url).endsWith("/load")).at(-1);
        routes = ((load?.body as { apps?: { http?: { servers?: { supacloud?: { routes?: Array<Record<string, unknown>> } } } } })
            ?.apps?.http?.servers?.supacloud?.routes) || [];
    } finally {
        restoreFetch();
    }

    const rest = routeById(routes, `route-project-${PROJECT_REF}-rest`);
    const auth = routeById(routes, `route-project-${PROJECT_REF}-auth`);
    const functions = routeById(routes, `route-project-${PROJECT_REF}-functions`);
    const storage = routeById(routes, `route-project-${PROJECT_REF}-storage`);
    const realtime = routeById(routes, `route-project-${PROJECT_REF}-realtime`);
    const opaque = routeById(routes, `route-project-${PROJECT_REF}-opaque-rest`);
    expect(dialPort(rest, 0)).toBe(PGRST_PORT);
    expect(dialPort(auth, 0)).toBe(GOTRUE_PORT);
    expect(dialPort(functions, 0)).toBe(config.port);
    expect(dialPort(functions, 1)).toBe(config.edgeRuntimePort);
    expect(dialPort(storage, 0)).toBe(config.port);
    expect(dialPort(storage, 1)).toBe(config.storageDataPlanePort);
    expect(dialPort(realtime, 0)).toBe(config.port);
    expect((opaque["handle"] as Array<Record<string, unknown>>).at(-1)?.["upstreams"]).toEqual([{ dial: `127.0.0.1:${config.port}` }]);

    const caddyBin = resolveCaddyBin();
    if (!caddyBin) {
        console.log("CONTROL_PLANE_OUTAGE_MEASUREMENT live drill skipped: caddy is not on PATH");
        return;
    }

    const host = String(((rest["match"] as Array<Record<string, unknown>>)[0]?.["host"] as string[])[0]);
    const token = await signedUserJwt();
    fixtureRoot = await mkdtemp(join(homedir(), ".supacloud-control-plane-outage-"));
    const projectRoot = await realpath(await mkdir(join(fixtureRoot, "functions", PROJECT_REF), { recursive: true }).then(() => join(fixtureRoot, "functions", PROJECT_REF)));
    const tenantsDir = join(fixtureRoot, "tenants");
    await mkdir(tenantsDir, { recursive: true });
    await writeFile(join(projectRoot, "ping.ts"), "export default () => new Response(\"served-by-edge\");\n");
    await writeFile(join(tenantsDir, `${PROJECT_REF}.env`), [
        "SUPACLOUD_AUTH_RUNTIME_MODE=local",
        `JWT_SECRET=${JWT_SECRET}`,
        "SUPABASE_ANON_KEY=outage-anon-key",
        "SUPABASE_SERVICE_ROLE_KEY=outage-service-key",
        `SUPACLOUD_PROJECT_REF=${PROJECT_REF}`,
        "",
    ].join("\n"));

    const postgrest = Bun.serve({ hostname: "127.0.0.1", port: PGRST_PORT, fetch: jwtUpstream("rest") });
    const gotrue = Bun.serve({ hostname: "127.0.0.1", port: GOTRUE_PORT, fetch: jwtUpstream("auth") });
    gateway = Bun.serve({
        hostname: "127.0.0.1",
        port: config.port,
        fetch: () => Response.json({ plane: "management" }),
    });

    const edge = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "../../../edge-runtime/server.ts"),
    ], {
        cwd: join(import.meta.dir, "../../../edge-runtime"),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            EDGE_RUNTIME_HOST: "127.0.0.1",
            EDGE_RUNTIME_PORT: String(config.edgeRuntimePort),
            EDGE_FUNCTIONS_DIR: join(fixtureRoot, "functions"),
            EDGE_FUNCTIONS_BASE_DIR: join(fixtureRoot, "functions"),
            TENANTS_DIR: tenantsDir,
            MANAGEMENT_API_URL: `http://127.0.0.1:${config.port}`,
            WORKER_POOL_SIZE: "1",
            BACKGROUND_WORKER_POOL_SIZE: "1",
            EDGE_FUNCTIONS_CORS_MODE: "auto",
        },
    });
    children.push(edge);
    void new Response(edge.stderr).text();
    const storagePlane = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "../../src/storage-data-plane.ts"),
    ], {
        cwd: join(import.meta.dir, "../.."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            BUN_ENV: "test",
            NODE_ENV: "test",
            STORAGE_DATA_PLANE_HOST: "127.0.0.1",
            STORAGE_DATA_PLANE_PORT: String(config.storageDataPlanePort),
        },
    });
    children.push(storagePlane);
    void new Response(storagePlane.stderr).text();

    await waitForHttp(`http://127.0.0.1:${config.edgeRuntimePort}/health`);
    await waitForHttp(`http://127.0.0.1:${config.storageDataPlanePort}/health`);

    const caddyConfigPath = join(tmpdir(), `supacloud-outage-caddy-${process.pid}.json`);
    const keptIds = new Set([
        `route-project-${PROJECT_REF}-rest`,
        `route-project-${PROJECT_REF}-auth`,
        `route-project-${PROJECT_REF}-functions`,
        `route-project-${PROJECT_REF}-storage`,
        `route-project-${PROJECT_REF}-realtime`,
        `route-project-${PROJECT_REF}-opaque-rest`,
    ]);
    const kept = routes.filter((route) => keptIds.has(String(route["@id"])));
    await writeFile(caddyConfigPath, JSON.stringify({
        admin: { disabled: true },
        apps: {
            http: {
                servers: {
                    drill: {
                        listen: ["127.0.0.1:18080"],
                        automatic_https: { disable: true },
                        routes: kept,
                    },
                },
            },
        },
    }));
    caddy = Bun.spawn([caddyBin, "run", "--config", caddyConfigPath], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const caddyStderr = new Response(caddy.stderr).text();
    const gatewayPort = 18080;
    const readyStarted = performance.now();
    let ready: { status: number; body: string } | undefined;
    let readyError = "";
    while (performance.now() - readyStarted < 5_000) {
        if (caddy.exitCode !== null) break;
        try {
            ready = await curl({ host, port: gatewayPort, path: "/rest/v1/items", token });
            if (ready.status === 200) break;
        } catch (error) {
            readyError = error instanceof Error ? error.message : String(error);
            ready = undefined;
        }
        await Bun.sleep(50);
    }
    if (ready?.status !== 200) {
        caddy.kill("SIGTERM");
        throw new Error(`gateway was not ready: ${ready?.status ?? "down"} ${ready?.body ?? readyError}\n${await caddyStderr}`);
    }

    const before = await curl({ host, port: gatewayPort, path: "/functions/v1/ping", token });
    expect(before.body).toContain("\"plane\":\"management\"");

    gateway.stop(true);
    gateway = undefined;
    const closeStarted = performance.now();
    let managementRefused = false;
    while (performance.now() - closeStarted < 2_000) {
        try {
            await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(200) });
        } catch {
            managementRefused = true;
            break;
        }
    }
    expect(managementRefused).toBe(true);
    const downAt = performance.now();

    const firstFunction = await curl({ host, port: gatewayPort, path: "/functions/v1/ping", token });
    const firstFunctionCompletedAt = performance.now();
    if (!firstFunction.body.includes("served-by-edge")) {
        edge.kill("SIGTERM");
        throw new Error(`function failover status ${firstFunction.status} body ${firstFunction.body.slice(0, 300)}`);
    }
    const functionSamples = [firstFunction];
    for (let index = 1; index < REQUESTS; index += 1) {
        functionSamples.push(await curl({ host, port: gatewayPort, path: "/functions/v1/ping", token }));
    }
    const restSamples = [];
    const authSamples = [];
    for (let index = 0; index < REQUESTS; index += 1) {
        restSamples.push(await curl({ host, port: gatewayPort, path: "/rest/v1/items", token }));
        authSamples.push(await curl({ host, port: gatewayPort, path: "/auth/v1/user", token }));
    }

    const directList = await fetch(`http://127.0.0.1:${config.storageDataPlanePort}/storage/v1/bucket`, {
        headers: { authorization: "Bearer test-token", apikey: "test-token" },
        signal: AbortSignal.timeout(5_000),
    });
    const directListBody = await directList.text();
    if (!directList.ok) {
        storagePlane.kill("SIGTERM");
        throw new Error(`storage data plane list ${directList.status} ${directListBody}`);
    }

    const storageViaGateway = await curl({ host, port: gatewayPort, path: "/storage/v1/bucket", token });
    const realtimeViaGateway = await curl({ host, port: gatewayPort, path: "/realtime/v1/websocket", token });
    const opaqueViaGateway = await curl({
        host,
        port: gatewayPort,
        path: "/rest/v1/items",
        token: "sb_publishable_outageoutofslosample",
    });

    const measurement = {
        executed_at: new Date().toISOString(),
        caddy: "v2.11.7",
        management_listener: "connection refused",
        listener_close_to_refused_ms: Math.round(performance.now() - closeStarted),
        backup_rpo: "unmeasured",
        backup_rto: "unmeasured",
        postgres_backed_storage: "unmeasured",
        postgrest_binary: "unmeasured",
        gotrue_binary: "unmeasured",
        planes: {
            rest: summary(restSamples),
            auth: summary(authSamples),
            functions: {
                ...summary(functionSamples),
                first_success_after_refused_ms: Math.round(firstFunction.latencyMs),
                down_at_to_first_response_ms: Math.round(firstFunctionCompletedAt - downAt),
            },
            storage_direct_test_mock: {
                list_status: directList.status,
                list_is_array: directListBody.trim().startsWith("["),
            },
            storage_via_gateway: {
                status: storageViaGateway.status,
                body_excerpt: storageViaGateway.body.slice(0, 180),
            },
            realtime_via_gateway: { status: realtimeViaGateway.status },
            opaque_rest_via_gateway: { status: opaqueViaGateway.status },
        },
    };
    console.log(`CONTROL_PLANE_OUTAGE_MEASUREMENT ${JSON.stringify(measurement)}`);

    expect(measurement.planes.rest.success).toBe(REQUESTS);
    expect(measurement.planes.auth.success).toBe(REQUESTS);
    expect(measurement.planes.functions.success).toBe(REQUESTS);
    expect(functionSamples.every((sample) => sample.body.includes("served-by-edge"))).toBe(true);
    expect(restSamples.every((sample) => sample.body.includes("\"plane\":\"rest\""))).toBe(true);
    expect(authSamples.every((sample) => sample.body.includes("\"plane\":\"auth\""))).toBe(true);
    expect(directListBody.trim().startsWith("[")).toBe(true);
    expect(storageViaGateway.status).not.toBe(502);
    expect(storageViaGateway.body.length).toBeGreaterThan(0);
    expect(realtimeViaGateway.status).toBeGreaterThanOrEqual(500);
    expect(opaqueViaGateway.status).toBeGreaterThanOrEqual(500);
    postgrest.stop(true);
    gotrue.stop(true);
});
