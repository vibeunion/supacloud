import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";
import os from "node:os";

export interface HealthReport {
    status: "OK" | "WARN" | "ERROR";
    component: string;
    message: string;
    recommendation?: string;
}

export class HealthChecker {
    /**
     * Run full system check
     */
    static async runFullCheck(): Promise<HealthReport[]> {
        const reports: HealthReport[] = [];

        // 1. System-level checks
        reports.push(await this.checkDiskSpace());
        reports.push(await this.checkMemory());

        // 2. Infrastructure service checks
        reports.push(await this.checkServiceStatus("supacloud", "Management API"));
        reports.push(await this.checkPigstyStatus());

        // 3. Database-specific checks
        reports.push(await this.checkPostgresHealth());

        // 4. Cloud-native storage check
        reports.push(await this.checkCloudStorage());

        return reports;
    }

    private static async checkCloudStorage(): Promise<HealthReport> {
        const mountPoint = config.storageMountPoint;
        try {
            const isMounted = (await $`mount | grep ${mountPoint}`.nothrow()).exitCode === 0;
            if (isMounted) {
                const df = await $`df -h ${mountPoint} | tail -n 1`.text();
                return {
                    component: "Cloud-native Storage (JuiceFS)",
                    status: "OK",
                    message: `Mounted: ${df.trim()}`
                };
            }
            return {
                component: "Cloud-native Storage",
                status: "OK",
                message: "Standard Mode (Local Storage)",
                recommendation: "Run 'supacloud storage setup' if elastic storage is needed."
            };
        } catch (err: unknown) {
          logger.warn("[HealthChecker] Cloud storage check failed", { error: err });
            return { component: "Cloud-native Storage", status: "WARN", message: "Cannot detect storage mount status" };
        }
    }

    private static async checkDiskSpace(): Promise<HealthReport> {
        try {
            const output = await $`df -h /opt | tail -1 | awk '{print $4}'`.text();
            const available = output.trim();
            const isLow = available.endsWith("M") || (available.endsWith("G") && parseFloat(available) < 5);

            return {
                component: "Storage Space",
                status: isLow ? "WARN" : "OK",
                message: `Available: ${available}`,
                recommendation: isLow ? "Recommend expanding disk or cleaning /var/log logs." : undefined
            };
        } catch (err: unknown) {
          logger.warn("[HealthChecker] Disk space check failed", { error: err });
            return { component: "Storage Space", status: "ERROR", message: "Cannot get disk info" };
        }
    }

    private static async checkMemory(): Promise<HealthReport> {
        const free = os.freemem() / 1024 / 1024 / 1024;
        const total = os.totalmem() / 1024 / 1024 / 1024;
        const isLow = free < 0.5;

        return {
            component: "Memory Status",
            status: isLow ? "WARN" : "OK",
            message: `Free ${free.toFixed(2)}GB / Total ${total.toFixed(2)}GB`,
            recommendation: isLow ? "Database is heavy, recommend adding RAM or enabling Swap." : undefined
        };
    }

    private static async checkServiceStatus(name: string, label: string): Promise<HealthReport> {
        try {
            // In Docker containers, systemctl may exist but usually cannot be used (PID 1 is not systemd)
            // Check if system is really booted by systemd
            const isSystemd = (await $`systemctl is-system-running`.nothrow().quiet()).exitCode === 0 ||
                (await $`systemctl --version`.nothrow().quiet()).exitCode === 0;

            const isContainer = (await $`test -f /.dockerenv`.nothrow()).exitCode === 0;

            if (!isSystemd) {
                return {
                    component: label,
                    status: isContainer ? "ERROR" : "WARN", // If not started in container, that's an error
                    message: "System not booted by Systemd",
                    recommendation: "Pigsty strongly depends on Systemd. Please ensure running on standard Linux distro or Systemd-enabled container."
                };
            }

            const isActive = (await $`systemctl is-active ${name}`.nothrow().quiet()).exitCode === 0;
            return {
                component: label,
                status: isActive ? "OK" : "ERROR",
                message: isActive ? "Running" : "Service stopped",
                recommendation: isActive ? undefined : `Try running 'sudo systemctl restart ${name}'.`
            };
        } catch (err: unknown) {
          logger.warn("[HealthChecker] Service status check failed", { error: err });
            return { component: label, status: "WARN", message: "Cannot access service status" };
        }
    }

    private static async checkPostgresHealth(): Promise<HealthReport> {
        try {
            // 1. Basic connectivity
            const isReady = (await $`pg_isready -h localhost`.nothrow()).exitCode === 0;
            if (!isReady) {
                return {
                    component: "Database (PostgreSQL)",
                    status: "ERROR",
                    message: "Database not accepting connections",
                    recommendation: "Check if port 5432 is blocked by firewall, or query 'systemctl status postgres'."
                };
            }

            // 2. Get version
            const pgVersionRaw = await $`sudo -u postgres psql -At -c "SHOW server_version;"`.nothrow().text();
            const pgVersion = pgVersionRaw.split(/\r?\n/)[0];

            // 3. Cluster HA detection (Patroni)
            const { ClusterManager } = await import("./cluster");
            const nodes: { role: string; state: string; member: string }[] = await ClusterManager.getStatus();

            if (nodes.length > 0) {
                const leader = nodes.find((n) => n.role === "Leader");
                const replicas = nodes.filter((n) => n.role === "Replica");
                const issues = nodes.filter((n) => n.state !== "running");

                if (!leader) {
                    return {
                        component: "Database Cluster (HA)",
                        status: "ERROR",
                        message: `Cluster (PG ${pgVersion.trim()}) currently has no leader`,
                        recommendation: "Patroni may be electing leader or ETCD has issues. Please run 'supacloud cluster health' to handle."
                    };
                }

                if (issues.length > 0) {
                    return {
                        component: "Database Cluster (HA)",
                        status: "WARN",
                        message: `PG ${pgVersion.trim()} has ${issues.length} nodes with abnormal status`,
                        recommendation: "At least one replica is down, HA availability reduced."
                    };
                }

                return {
                    component: "Database Cluster (HA)",
                    status: "OK",
                    message: `Cluster healthy (PG ${pgVersion.trim()}, Primary: ${leader.member}, Alive replicas: ${replicas.length})`
                };
            }

            // 4. Fallback: Detect primary-replica sync (try simple query on management DB)
            const syncStatus = await $`sudo -u postgres psql -At -c "SELECT count(*) FROM pg_stat_replication;"`.nothrow();
            if (syncStatus.exitCode === 0) {
                const replicas = parseInt(syncStatus.stdout.toString().trim());
                return {
                    component: "Database Connection",
                    status: "OK",
                    message: `PostgreSQL ${pgVersion.trim()} ready (Active replicas: ${replicas})`
                };
            }

            return { component: "Database (PostgreSQL)", status: "OK", message: `PG ${pgVersion.trim()} running in single-node mode` };
        } catch (err: unknown) {
          logger.warn("[HealthChecker] PostgreSQL health check failed", { error: err });
            return { component: "Database", status: "WARN", message: "Cannot detect detailed database metrics" };
        }
    }

    private static async checkPigstyStatus(): Promise<HealthReport> {
        try {
            const version = await $`pig version`.nothrow().text();
            if (version.trim()) {
                return {
                    component: "Pigsty Engine",
                    status: "OK",
                    message: `Ready (${version.split(/\r?\n/)[0].trim()})`
                };
            }
        } catch (e: unknown) { logger.debug("[infra/health] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
        return this.checkServiceStatus("pigsty", "Pigsty Infrastructure");
    }
}
