import { $ } from "bun";
import os from "node:os";

export interface HealthReport {
    status: "OK" | "WARN" | "ERROR";
    component: string;
    message: string;
    recommendation?: string;
}

export class HealthChecker {
    /**
     * 运行全量体检
     */
    static async runFullCheck(): Promise<HealthReport[]> {
        const reports: HealthReport[] = [];

        // 1. 系统级检查
        reports.push(await this.checkDiskSpace());
        reports.push(await this.checkMemory());

        // 2. 基础设施服务检查
        reports.push(await this.checkServiceStatus("supacloud-api", "Management API"));
        reports.push(await this.checkServiceStatus("pigsty", "Pigsty Infrastructure"));
        reports.push(await this.checkServiceStatus("angie", "Load Balancer (Angie)"));

        // 3. 数据库专项检查
        reports.push(await this.checkPostgresHealth());

        // 4. 云原生存储检查
        reports.push(await this.checkCloudStorage());

        return reports;
    }

    private static async checkCloudStorage(): Promise<HealthReport> {
        const mountPoint = process.env.STORAGE_MOUNT_POINT || "/mnt/supacloud";
        try {
            const isMounted = (await $`mount | grep ${mountPoint}`.nothrow()).exitCode === 0;
            if (isMounted) {
                const df = await $`df -h ${mountPoint} | tail -n 1`.text();
                return {
                    component: "云原生存储 (JuiceFS)",
                    status: "OK",
                    message: `已挂载: ${df.trim()}`
                };
            }
            return {
                component: "云原生存储",
                status: "WARN",
                message: "未挂载云原生存储后端",
                recommendation: "如果需要云端弹性存储，请运行 'supacloud storage setup'。"
            };
        } catch {
            return { component: "云原生存储", status: "ERROR", message: "无法探测存储挂载状态" };
        }
    }

    private static async checkDiskSpace(): Promise<HealthReport> {
        try {
            const output = await $`df -h /opt | tail -1 | awk '{print $4}'`.text();
            const available = output.trim();
            const isLow = available.endsWith("M") || (available.endsWith("G") && parseFloat(available) < 5);

            return {
                component: "存储空间",
                status: isLow ? "WARN" : "OK",
                message: `可用空间: ${available}`,
                recommendation: isLow ? "建议扩容磁盘或清理 /var/log 日志。" : undefined
            };
        } catch {
            return { component: "存储空间", status: "ERROR", message: "无法获取磁盘信息" };
        }
    }

    private static async checkMemory(): Promise<HealthReport> {
        const free = os.freemem() / 1024 / 1024 / 1024;
        const total = os.totalmem() / 1024 / 1024 / 1024;
        const isLow = free < 0.5;

        return {
            component: "内存状态",
            status: isLow ? "WARN" : "OK",
            message: `剩余 ${free.toFixed(2)}GB / 总计 ${total.toFixed(2)}GB`,
            recommendation: isLow ? "由于数据库较重，建议增加 RAM 或启用 Swap。" : undefined
        };
    }

    private static async checkServiceStatus(name: string, label: string): Promise<HealthReport> {
        try {
            const isActive = (await $`systemctl is-active ${name}`.nothrow()).exitCode === 0;
            return {
                component: label,
                status: isActive ? "OK" : "ERROR",
                message: isActive ? "运行中" : "服务已停止",
                recommendation: isActive ? undefined : `尝试运行 'sudo systemctl restart ${name}'。`
            };
        } catch {
            return { component: label, status: "WARN", message: "非 Systemd 环境或无权访问" };
        }
    }

    private static async checkPostgresHealth(): Promise<HealthReport> {
        try {
            // 检查 pg_isready
            const isReady = (await $`pg_isready -h localhost`.nothrow()).exitCode === 0;
            if (!isReady) {
                return {
                    component: "数据库 (PostgreSQL)",
                    status: "ERROR",
                    message: "数据库不接受连接",
                    recommendation: "检查端口 5432 是否被防火墙拦截，或查询 'systemctl status postgres'。"
                };
            }

            // 检查主从同步 (尝试在管理库执行简单查询)
            const syncStatus = await $`psql -At -c "SELECT count(*) FROM pg_stat_replication;"`.nothrow();
            if (syncStatus.exitCode === 0) {
                const replicas = parseInt(syncStatus.stdout.toString().trim());
                return {
                    component: "数据库集群",
                    status: "OK",
                    message: `PostgreSQL 已就绪 (活动副本数: ${replicas})`
                };
            }

            return { component: "数据库 (PostgreSQL)", status: "OK", message: "单节点运行中" };
        } catch {
            return { component: "数据库", status: "WARN", message: "无法探测详细数据库指标" };
        }
    }
}
