import { logger } from "../utils/logger";
import { gatewayService } from "../services/gateway.service";

// 自愈周期：默认 60s 轮询 Caddy Admin API 可达性。systemd 模式下 caddy 直接用 config.json
// 启动，重启后会加载磁盘快照；若 management-api 内存态在此期间变化，快照即过时。docker 模式
// 依赖 ensureGatewayReady 完成首次注入，本 worker 提供持续的自愈：检测到"从不可达恢复可达"
// （caddy 重启信号）即触发全量重建 + JSON /load，让最新路由配置接管。
const HEALTH_CHECK_INTERVAL_MS = Number(process.env.GATEWAY_HEALTH_CHECK_INTERVAL_MS || 60 * 1000);
const INITIAL_DELAY_MS = Number(process.env.GATEWAY_HEALTH_CHECK_INITIAL_DELAY_MS || 30 * 1000);
const ROUTE_RECONCILE_INTERVAL_MS = Number(process.env.GATEWAY_ROUTE_RECONCILE_INTERVAL_MS || 5 * 60 * 1000);

let healthTimer: Timer | null = null;

// 内部可达性状态：用于检测"不可达 -> 可达"的边沿跳变。export 仅用于测试重置。
let lastSeenReachable = false;
let lastRouteReconcileAt = 0;

export function resetGatewayHealthState(): void {
    lastSeenReachable = false;
    lastRouteReconcileAt = 0;
}

interface HealthCheckDeps {
    // 触发全量租户路由重建（rebuildAllTenantConfigs），默认走 gatewayService。
    rebuildAll?: () => Promise<{ success: boolean; updated: number; errors: string[] }>;
    // 测试可注入时钟和周期，生产环境使用环境变量配置。
    now?: () => number;
    reconcileIntervalMs?: number;
}

// 执行一次健康探测。返回本轮是否触发了全量重建。
export async function runGatewayHealthCheck(deps?: HealthCheckDeps): Promise<boolean> {
    const rebuildAll = deps?.rebuildAll ?? (() => gatewayService.rebuildAllTenantConfigs());
    const now = deps?.now?.() ?? Date.now();
    const reconcileIntervalMs = Math.max(0, deps?.reconcileIntervalMs ?? ROUTE_RECONCILE_INTERVAL_MS);

    const rebuild = async (reason: "recovered" | "periodic"): Promise<boolean> => {
        lastRouteReconcileAt = now;
        const result = await rebuildAll();
        if (!result.success) {
            logger.warn(`[GatewayHealth] Gateway ${reason} rebuild completed with errors`, {
                updated: result.updated,
                errors: result.errors,
            });
        } else if (result.updated > 0) {
            logger.info(`[GatewayHealth] Gateway ${reason} rebuild applied`, { updated: result.updated });
        }
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

        // 从不可达恢复可达（含首次启动）：触发全量重建让最新内存态接管。
        if (!lastSeenReachable) {
            logger.info("[GatewayHealth] Caddy reachable (recovered or first contact); rebuilding gateway config");
            lastSeenReachable = true;
            return rebuild("recovered");
        }

        // Caddy can stay reachable while its live config is changed out-of-band
        // (for example by a restart hook or an operator patch). Periodically
        // replay the persisted tenant routes so managed upstreams and headers
        // cannot remain stale indefinitely.
        if (reconcileIntervalMs === 0 || now - lastRouteReconcileAt >= reconcileIntervalMs) {
            return rebuild("periodic");
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
