import { SQL } from "bun";
import { extractFlowShape } from "@pgflow/dsl";
import { loadFlow } from "./flow-module";
import { grantPgflowWorker, readPgflowState } from "../../management-api/src/services/pgflow.service";

export async function compileFlow(): Promise<void> {
    const url = process.env.DATABASE_URL;
    const role = process.env.PGFLOW_WORKER_ROLE;
    if (!url || !role) throw new Error("Project database URL and worker role are required");
    const flow = await loadFlow(process.env.PGFLOW_FLOW_MODULE ?? "/flows/flow.ts");
    const db = new SQL(url, { max: 1, connectionTimeout: 5 });
    try {
        await db.begin(async (transaction) => {
            await transaction`SELECT pg_advisory_xact_lock(1937076332, 1)`;
            if (!(await readPgflowState(transaction)).managed) throw new Error("Enable the managed pgflow core first");
            const [result] = await transaction`
                SELECT pgflow.ensure_flow_compiled(${flow.slug}, ${JSON.stringify(extractFlowShape(flow))}::text::jsonb)->>'status' AS status
            `;
            if (!result || !["compiled", "verified"].includes(result.status)) {
                throw new Error("Flow shape differs; an explicit reviewed migration is required");
            }
            await grantPgflowWorker(transaction, role);
        });
    } finally {
        await db.close({ timeout: 5 });
    }
}

if (import.meta.main) {
    compileFlow().then(() => console.info("[pgflow] flow compiled and runtime grants applied")).catch(() => {
        console.error("[pgflow] flow deployment failed; no runtime grant was committed");
        process.exitCode = 1;
    });
}
