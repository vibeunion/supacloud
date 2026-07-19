import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CADDY_STARTUP_MARKER = "serving initial configuration";
const CADDY_STARTUP_TIMEOUT_MS = 5_000;

type CaddyProcess = {
    readonly exitCode: number | null;
    readonly exited: Promise<number>;
    readonly stderr: ReadableStream<Uint8Array>;
    kill(signal?: number | NodeJS.Signals): void;
};

type StartupOutcome = {
    started: boolean;
    detail: string;
};

function startupTimeout(): { promise: Promise<StartupOutcome>; cancel: () => void } {
    let timeoutId: ReturnType<typeof setTimeout>;
    const promise = new Promise<StartupOutcome>((resolve) => {
        timeoutId = setTimeout(() => resolve({ started: false, detail: "startup timed out" }), CADDY_STARTUP_TIMEOUT_MS);
    });
    return { promise, cancel: () => clearTimeout(timeoutId) };
}

function recordOf(candidateValue: unknown): Record<string, unknown> | undefined {
    return typeof candidateValue === "object" && candidateValue !== null && !Array.isArray(candidateValue)
        ? candidateValue as Record<string, unknown>
        : undefined;
}

function collectCaddyIds(caddyNode: unknown, location: string, seen: Map<string, string>): void {
    if (Array.isArray(caddyNode)) {
        caddyNode.forEach((entry, index) => collectCaddyIds(entry, `${location}/${index}`, seen));
        return;
    }

    const record = recordOf(caddyNode);
    if (!record) return;
    const id = record["@id"];
    if (typeof id === "string" && id) {
        const firstLocation = seen.get(id);
        if (firstLocation) throw new Error(`Duplicate Caddy @id '${id}' at ${firstLocation} and ${location}`);
        seen.set(id, location);
    }
    for (const [key, entry] of Object.entries(record)) collectCaddyIds(entry, `${location}/${key}`, seen);
}

export function assertUniqueCaddyIds(candidateConfig: unknown): void {
    collectCaddyIds(candidateConfig, "/config", new Map());
}

function isolatedStartupConfig(candidateConfig: unknown, storageRoot: string): Record<string, unknown> {
    const isolatedConfig = structuredClone(candidateConfig) as Record<string, unknown>;
    isolatedConfig.admin = { disabled: true };
    isolatedConfig.storage = { module: "file_system", root: storageRoot };

    const apps = recordOf(isolatedConfig.apps);
    if (!apps) return isolatedConfig;
    delete apps.tls;
    const servers = recordOf(recordOf(apps.http)?.servers);
    if (!servers) return isolatedConfig;
    for (const serverValue of Object.values(servers)) {
        const server = recordOf(serverValue);
        if (!server) continue;
        server.listen = ["127.0.0.1:0"];
        server.automatic_https = { disable: true };
        delete server.tls_connection_policies;
    }
    return isolatedConfig;
}

async function readStartupOutcome(stderr: ReadableStream<Uint8Array>): Promise<StartupOutcome> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    let detail = "";
    try {
        while (true) {
            const chunk = await reader.read();
            detail += decoder.decode(chunk.value, { stream: !chunk.done });
            if (detail.includes(CADDY_STARTUP_MARKER)) return { started: true, detail };
            if (chunk.done) return { started: false, detail };
            if (detail.length > 4_000) detail = detail.slice(-4_000);
        }
    } finally {
        reader.releaseLock();
    }
}

async function terminateCaddyProcess(caddyProcess: CaddyProcess): Promise<number> {
    if (caddyProcess.exitCode !== null) return caddyProcess.exited;
    caddyProcess.kill("SIGTERM");
    await Promise.race([caddyProcess.exited, Bun.sleep(1_000)]);
    if (caddyProcess.exitCode === null) caddyProcess.kill("SIGKILL");
    return caddyProcess.exited;
}

async function verifyCaddyStarts(binaryPath: string, preflightPath: string, stateRoot: string): Promise<void> {
    const caddyProcess = Bun.spawn([binaryPath, "run", "--config", preflightPath], {
        env: {
            ...globalThis.process.env,
            XDG_CONFIG_HOME: join(stateRoot, "config"),
            XDG_DATA_HOME: join(stateRoot, "data"),
        },
        stdout: "ignore",
        stderr: "pipe",
    });
    const timeout = startupTimeout();
    try {
        const outcome = await Promise.race([readStartupOutcome(caddyProcess.stderr), timeout.promise]);
        if (outcome.started) return;
        const detail = outcome.detail.trim().slice(-1_000) || "Caddy exited before startup completed";
        throw new Error(`Caddy startup preflight failed: ${detail}`);
    } finally {
        timeout.cancel();
        await terminateCaddyProcess(caddyProcess);
    }
}

export async function runCaddyStartupPreflight(
    binaryPath: string,
    candidatePath: string,
    candidateConfig: unknown,
): Promise<void> {
    const runId = `${globalThis.process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workDir = `${candidatePath}.startup-preflight-${runId}`;
    const preflightPath = join(workDir, "config.json");
    await mkdir(workDir, { recursive: true });
    try {
        const isolated = isolatedStartupConfig(candidateConfig, join(workDir, "storage"));
        await writeFile(preflightPath, JSON.stringify(isolated));
        await verifyCaddyStarts(binaryPath, preflightPath, workDir);
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
}
