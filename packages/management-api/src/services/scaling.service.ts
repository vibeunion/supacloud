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
     * Execute elastic scaling check for a single project
     */
    static async checkAndScale(projectRef: string): Promise<{ action: string; reason?: string }> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project || project.status !== 'active') {
            return { action: 'none' };
        }

        // Default to primary node port (In Pigsty mode, primary/replica IPs may differ, simplified logic here)
        const nodeIp = 'localhost';
        const metrics = await MonitorService.getMetrics(nodeIp);

        // 1. Vertical scaling check (CPU/MEM)
        if (metrics.cpu_usage! > DEFAULT_THRESHOLDS.cpuHigh || metrics.mem_usage! > DEFAULT_THRESHOLDS.memHigh) {
            const reason = metrics.cpu_usage! > DEFAULT_THRESHOLDS.cpuHigh ? 'CPU load too high' : 'Memory pressure high';
            await this.verticalScale(projectRef, 'pro'); // Demo logic: upgrade to pro tier directly
            return { action: 'vertical_scale', reason };
        }

        // 2. Horizontal scaling check (QPS/Conn)
        if (metrics.qps > DEFAULT_THRESHOLDS.qpsHigh || metrics.active_connections > DEFAULT_THRESHOLDS.connectionsHigh) {
            const reason = metrics.qps > DEFAULT_THRESHOLDS.qpsHigh ? 'QPS peak too high' : 'Too many connections';
            // Simulate allocating an internal IP for replica expansion
            const nextIp = `10.0.0.${Math.floor(Math.random() * 200) + 10}`;
            await this.horizontalScale(projectRef, nextIp);
            return { action: 'horizontal_scale', reason };
        }

        return { action: 'none' };
    }

    /**
     * Vertical scaling: Adjust resource limits
     */
    private static async verticalScale(projectRef: string, tier: string): Promise<void> {
        console.log(`Executing vertical scaling: ${projectRef} -> ${tier}`);
        const limits = tier === 'pro' ? 'cpu=4,mem=8g' : 'cpu=2,mem=4g';
        await shellService.execute('ha_manager.sh', ['vertical_scale', `supa_${projectRef}`, limits]);
    }

    /**
     * Horizontal scaling: Add read replica and register to gateway
     */
    private static async horizontalScale(projectRef: string, replicaIp: string): Promise<void> {
        console.log(`Executing horizontal scaling: ${projectRef} adding replica ${replicaIp}`);

        // 1. Execute replica initialization (time-consuming task)
        await MaintenanceService.addReplica(replicaIp);

        // 2. Asynchronously register to gateway load balancer (Since initialization is time-consuming, should actually wait for Job completion before registering)
        // Demo calls directly here
        await shellService.execute('gateway_manager.sh', ['add-upstream-target', projectRef, replicaIp]);
    }
}
