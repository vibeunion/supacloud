import { logger } from "../utils/logger";
import { tenantRuntimeService } from "../services/tenant-runtime.service";

const RECONCILE_INTERVAL_MS = Number(process.env.RUNTIME_RECONCILE_INTERVAL_MS || 10 * 60 * 1000);
const INITIAL_DELAY_MS = Number(process.env.RUNTIME_RECONCILE_INITIAL_DELAY_MS || 60 * 1000);

let reconcileTimer: Timer | null = null;
let reconciliationInFlight: Promise<void> | null = null;

async function performRuntimeReconciliation(): Promise<void> {
    try {
        const stats = await tenantRuntimeService.reconcileInactiveRuntimes();
        if (stats.stopped > 0 || stats.started > 0 || stats.updated > 0 || stats.errors > 0) {
            logger.info("[RuntimeReconcile] Completed", stats);
        } else {
            logger.debug("[RuntimeReconcile] No runtime drift detected", stats);
        }
    } catch (error: unknown) {
        logger.warn("[RuntimeReconcile] Reconciliation failed", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export function runRuntimeReconciliation(): Promise<void> {
    if (reconciliationInFlight) return reconciliationInFlight;

    const run = performRuntimeReconciliation().finally(() => {
        if (reconciliationInFlight === run) reconciliationInFlight = null;
    });
    reconciliationInFlight = run;
    return run;
}

export function startRuntimeReconcileWorker(): void {
    if (reconcileTimer) return;

    logger.info(`[RuntimeReconcile] Worker started (interval: ${RECONCILE_INTERVAL_MS}ms)`);

    const initialDelay = setTimeout(() => {
        void runRuntimeReconciliation();
    }, INITIAL_DELAY_MS);

    reconcileTimer = setInterval(() => {
        void runRuntimeReconciliation();
    }, RECONCILE_INTERVAL_MS);

    (reconcileTimer as any).__initialDelay = initialDelay;
}

export function stopRuntimeReconcileWorker(): void {
    if (!reconcileTimer) return;

    clearInterval(reconcileTimer);
    const initialDelay = (reconcileTimer as any).__initialDelay;
    if (initialDelay) clearTimeout(initialDelay);
    reconcileTimer = null;
    logger.info("[RuntimeReconcile] Worker stopped");
}
