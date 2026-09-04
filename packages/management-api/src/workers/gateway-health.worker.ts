import { logger } from "../utils/logger";
import {
    gatewayService,
    reconcileCanonicalGatewayRoutes,
    type CanonicalGatewayReconcileState,
} from "../services/gateway.service";

// Caddy restarts from its durable config, which can lag behind Management state while it is
// unavailable. Recovery edges and periodic checks therefore use the same full reconciliation;
// only master, tenant/custom, hosted auth, frontend, and live read-back success marks recovery.
const HEALTH_CHECK_INTERVAL_MS = Number(process.env.GATEWAY_HEALTH_CHECK_INTERVAL_MS || 60 * 1000);
const INITIAL_DELAY_MS = Number(process.env.GATEWAY_HEALTH_CHECK_INITIAL_DELAY_MS || 30 * 1000);
const ROUTE_RECONCILE_INTERVAL_MS = Number(process.env.GATEWAY_ROUTE_RECONCILE_INTERVAL_MS || 5 * 60 * 1000);

let healthTimer: Timer | null = null;

// Internal reachability state: detects "unreachable -> reachable" edge transitions. Exported only for test resets.
let lastSeenReachable = false;
let lastRouteReconcileAt = 0;

export function resetGatewayHealthState(): void {
    lastSeenReachable = false;
    lastRouteReconcileAt = 0;
}

interface HealthCheckDeps {
    reconcileAll?: () => Promise<CanonicalGatewayReconcileState>;
    // Tests may inject clock and interval; production uses environment configuration.
    now?: () => number;
    reconcileIntervalMs?: number;
}

// Executes a health probe. Returns whether canonical reconciliation was performed in this round.
export async function runGatewayHealthCheck(deps?: HealthCheckDeps): Promise<boolean> {
    const reconcileAll = deps?.reconcileAll ?? reconcileCanonicalGatewayRoutes;
    const now = deps?.now?.() ?? Date.now();
    const reconcileIntervalMs = Math.max(0, deps?.reconcileIntervalMs ?? ROUTE_RECONCILE_INTERVAL_MS);

    const reconcile = async (reason: "recovered" | "periodic"): Promise<boolean> => {
        const state = await reconcileAll();
        lastRouteReconcileAt = now;
        logger.info(`[GatewayHealth] Canonical gateway ${reason} reconciliation applied`, {
            tenants: state.tenants.updated,
            frontends: state.frontends.configured,
        });
        return true;
    };

    try {
        const reachable = await gatewayService.checkCaddyConnectivity();

        if (!reachable) {
            if (lastSeenReachable) {
                logger.warn("[GatewayHealth] Caddy Admin API became unreachable; will rebuild on recovery");
            }
            lastSeenReachable = false;
            return false;
        }

        // Recovered from unreachable (including initial startup): trigger full rebuild so latest in-memory state takes over.
        if (!lastSeenReachable) {
            logger.info("[GatewayHealth] Caddy reachable; reconciling the canonical gateway state");
            const reconciled = await reconcile("recovered");
            lastSeenReachable = true;
            return reconciled;
        }

        // Caddy can stay reachable while its live config is changed out-of-band
        // (for example by a restart hook or an operator patch). Periodically
        // replay the persisted tenant routes so managed upstreams and headers
        // cannot remain stale indefinitely.
        if (reconcileIntervalMs === 0 || now - lastRouteReconcileAt >= reconcileIntervalMs) {
            return reconcile("periodic");
        }

        return false;
    } catch (error: unknown) {
        logger.warn("[GatewayHealth] Health check failed", {
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

export function startGatewayHealthWorker(): void {
    if (healthTimer) return;

    logger.info(`[GatewayHealth] Worker started (interval: ${HEALTH_CHECK_INTERVAL_MS}ms)`);

    const initialDelay = setTimeout(() => {
        void runGatewayHealthCheck();
    }, INITIAL_DELAY_MS);

    healthTimer = setInterval(() => {
        void runGatewayHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    (healthTimer as any).__initialDelay = initialDelay;
}

export function stopGatewayHealthWorker(): void {
    if (!healthTimer) return;

    clearInterval(healthTimer);
    const initialDelay = (healthTimer as any).__initialDelay;
    if (initialDelay) clearTimeout(initialDelay);
    healthTimer = null;
    logger.info("[GatewayHealth] Worker stopped");
}
