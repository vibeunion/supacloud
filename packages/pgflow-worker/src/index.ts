import { SQL } from "bun";
import { EdgeWorker } from "@pgflow/edge-worker";
import { PGFLOW_RUNTIME_SHA256, PGFLOW_VERSION } from "../../management-api/src/services/pgflow.service";
import { loadFlow } from "./flow-module";

export async function runPgflowWorker(): Promise<void> {
    const url = process.env.DATABASE_URL;
    const name = process.env.WORKER_NAME;
    const modulePath = process.env.PGFLOW_FLOW_MODULE ?? "/flows/flow.ts";
    if (!url || !name || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
        throw new Error("Worker configuration is incomplete");
    }
    const db = new SQL(url, { max: 1, connectionTimeout: 5, idleTimeout: 10 });
    let recovery: Promise<void> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
        const [state] = await db`SELECT * FROM pgflow._supacloud_runtime_status()`;
        if (state?.version !== PGFLOW_VERSION || state?.bundle_sha256 !== PGFLOW_RUNTIME_SHA256) {
            throw new Error("Worker requires the matching managed pgflow bundle");
        }
        const flow = await loadFlow(modulePath);
        const [compiled] = await db`SELECT 1 FROM pgflow.flows WHERE flow_slug = ${flow.slug}`;
        if (!compiled) throw new Error("Compile the flow with the deployment role before starting its worker");
        const platform = await EdgeWorker.start(flow, {
            connectionString: url, maxPgConnections: 4, maxPollSeconds: 1,
        });
        const recover = (): Promise<void> => {
            recovery ??= (async () => {
                await db`SELECT pgflow._supacloud_recover()`;
            })().catch(() => {
                console.error("[pgflow] recovery failed");
            }).finally(() => { recovery = undefined; });
            return recovery;
        };
        await recover();
        timer = setInterval(() => { void recover(); }, 10_000);
        console.info("[pgflow] worker ready");
        // Upstream owns process signal handling and drains accepted work.
        await new Promise<void>((resolve) => {
            if (platform.shutdownSignal.aborted) resolve();
            else platform.shutdownSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        clearInterval(timer);
        await recovery;
        await EdgeWorker.stop();
    } finally {
        if (timer) clearInterval(timer);
        await recovery;
        await db.close({ timeout: 5 });
    }
}

if (import.meta.main) {
    runPgflowWorker().catch(() => {
        // Flow errors and connection strings may contain project secrets.
        console.error("[pgflow] worker stopped: startup or runtime failure");
        process.exitCode = 1;
    });
}
