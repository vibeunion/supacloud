import type { SQL } from "bun";
import { getProjectDb, resolveDbName, sql } from "../db";
import { logger } from "../utils/logger";
import { readPgflowState } from "../services/pgflow.service";
import { scheduledFunctionWorker, type TriggerResult } from "./scheduled-function.worker";

export interface PgflowDispatcherDependencies {
    projects: () => Promise<string[]>;
    database: (ref: string) => Promise<SQL>;
    invoke: (ref: string, slug: string) => Promise<TriggerResult>;
    report: (ref: string) => void;
}

export class PgflowDispatcher {
    private timer: ReturnType<typeof setInterval> | undefined;
    private running: Promise<void> | undefined;

    constructor(private readonly dependencies: PgflowDispatcherDependencies) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, 10_000);
        this.timer.unref();
        void this.tick();
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        await this.running;
    }

    tick(): Promise<void> {
        if (this.running) return this.running;
        this.running = this.dispatch().catch(() => {
            this.dependencies.report("inventory");
        }).finally(() => { this.running = undefined; });
        return this.running;
    }

    private async dispatch(): Promise<void> {
        for (const ref of await this.dependencies.projects()) {
            try {
                const db = await this.dependencies.database(ref);
                if (!(await readPgflowState(db, ref)).enabled) continue;
                const workers = await db.begin(async (transaction) => {
                    // Reserve under the pause fence, but never hold a database
                    // lock across HTTP. Accepted wakeups may arrive after pause;
                    // the SQL claim gate still prevents them starting new tasks.
                    await transaction`SELECT pg_advisory_xact_lock_shared(1937076332, 1)`;
                    if (!(await readPgflowState(transaction, ref)).enabled) return [];
                    const claimed = await transaction`
                        UPDATE pgflow.worker_functions AS f SET last_invoked_at = clock_timestamp()
                        WHERE f.function_name IN (
                            SELECT w.function_name FROM pgflow.worker_functions w
                            WHERE w.enabled AND w.start_mode = 'http'
                                AND (w.last_invoked_at IS NULL OR w.last_invoked_at < clock_timestamp() - interval '30 seconds')
                                AND NOT EXISTS (
                                    SELECT 1 FROM pgflow.workers alive
                                    WHERE alive.function_name = w.function_name
                                        AND alive.stopped_at IS NULL AND alive.deprecated_at IS NULL
                                        AND alive.last_heartbeat_at > clock_timestamp() - interval '30 seconds'
                                )
                            ORDER BY w.last_invoked_at NULLS FIRST, w.function_name
                            LIMIT 4 FOR UPDATE OF w SKIP LOCKED
                        )
                        RETURNING f.function_name
                        `;
                    await transaction`SELECT pgflow._supacloud_recover()`;
                    return claimed;
                });
                for (const worker of workers) {
                    if (typeof worker.function_name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(worker.function_name)) continue;
                    if (!(await readPgflowState(db, ref)).enabled) break;
                    const result = await this.dependencies.invoke(ref, worker.function_name);
                    if (!result.ok) this.dependencies.report(ref);
                }
            } catch {
                this.dependencies.report(ref);
            }
        }
    }
}

export const pgflowDispatcher = new PgflowDispatcher({
    projects: async () => {
        const rows = await sql`
            SELECT ref FROM projects WHERE deleted_at IS NULL
            AND config #>> '{pgflow,managed}' = 'true' ORDER BY ref
        `;
        return rows.map((row: { ref?: unknown }) => row.ref)
            .filter((ref: unknown): ref is string => typeof ref === "string");
    },
    database: async (ref) => getProjectDb(await resolveDbName(ref)),
    invoke: async (ref, slug) => {
        const now = new Date().toISOString();
        return scheduledFunctionWorker.triggerOnce(ref, {
            id: crypto.randomUUID(), name: `pgflow:${slug.slice(0, 110)}`, slug, cron: "* * * * *",
            method: "POST", body: {}, enabled: true, created_at: now, updated_at: now,
        });
    },
    report: (ref) => logger.warn(`[pgflow] dispatch failed for ${ref}`),
});
