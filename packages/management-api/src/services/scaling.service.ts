import { MonitorService } from './monitor.service';
import { MaintenanceService } from './maintenance.service';
import { shellService } from './shell.service';
import { projectRepository } from '../repositories/project.repository';

export interface ScalingThresholds {
    cpuHigh: number;
    memHigh: number;
    qpsHigh: number;
    connectionsHigh: number;
}

const DEFAULT_THRESHOLDS: ScalingThresholds = {
    cpuHigh: 80,
    memHigh: 80,
    qpsHigh: 500,
    connectionsHigh: 100
};

export class ScalingService {
    /**
     * 针对单个项目执行弹性伸缩检查
     */
    static async checkAndScale(projectRef: string): Promise<{ action: string; reason?: string }> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project || project.status !== 'active') {
            return { action: 'none' };
        }

        // 默认获取主库节点端口（Pigsty 模式下通常主从 IP 可能不同，此处简化逻辑）
        const nodeIp = 'localhost';
        const metrics = await MonitorService.getMetrics(nodeIp);

        // 1. 垂直扩容检查 (CPU/MEM)
        if (metrics.cpu_usage! > DEFAULT_THRESHOLDS.cpuHigh || metrics.mem_usage! > DEFAULT_THRESHOLDS.memHigh) {
            const reason = metrics.cpu_usage! > DEFAULT_THRESHOLDS.cpuHigh ? 'CPU 负载过高' : '内存压力大';
            await this.verticalScale(projectRef, 'pro'); // 演示逻辑：直接提升到 pro 规格
            return { action: 'vertical_scale', reason };
        }

        // 2. 水平扩容检查 (QPS/Conn)
        if (metrics.qps > DEFAULT_THRESHOLDS.qpsHigh || metrics.active_connections > DEFAULT_THRESHOLDS.connectionsHigh) {
            const reason = metrics.qps > DEFAULT_THRESHOLDS.qpsHigh ? 'QPS 峰值过大' : '连接数过多';
            // 模拟分配一个内网 IP 扩容副本
            const nextIp = `10.0.0.${Math.floor(Math.random() * 200) + 10}`;
            await this.horizontalScale(projectRef, nextIp);
            return { action: 'horizontal_scale', reason };
        }

        return { action: 'none' };
    }

    /**
     * 垂直扩容：调整资源限制
     */
    private static async verticalScale(projectRef: string, tier: string): Promise<void> {
        console.log(`执行垂直扩容: ${projectRef} -> ${tier}`);
        const limits = tier === 'pro' ? 'cpu=4,mem=8g' : 'cpu=2,mem=4g';
        await shellService.execute('ha_manager.sh', ['vertical_scale', `supa_${projectRef}`, limits]);
    }

    /**
     * 水平扩容：添加只读副本并注册到网关
     */
    private static async horizontalScale(projectRef: string, replicaIp: string): Promise<void> {
        console.log(`执行水平扩容: ${projectRef} 增加副本 ${replicaIp}`);

        // 1. 执行副本初始化 (耗时任务)
        await MaintenanceService.addReplica(replicaIp);

        // 2. 异步注册到网关负载均衡器 (由于初始化耗时，实际应等 Job 完成后再注册)
        // 此处演示直接调用
        await shellService.execute('gateway_manager.sh', ['add-upstream-target', projectRef, replicaIp]);
    }
}
