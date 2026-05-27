import { getMetrics } from './monitor.service';
import { logger } from "../utils/logger";
import { shellService } from './shell.service';
import { projectRepository } from '../repositories/project.repository';
import { normalizeProjectConfig } from '../utils/project-config';
import { gatewayService } from './gateway.service';

export type ComputeScalingStatus = "active" | "scaling" | "failed";
export type ReadReplicaStatus = "provisioning" | "active" | "deleting" | "deleted" | "failed";

export interface ComputeState {
    tier: string;
    status: ComputeScalingStatus;
    cpu: number;
    memory: string;
    updated_at: string;
    last_error?: string;
}

export interface ReadReplicaRecord {
    id: string;
    ip: string;
    region: string;
    status: ReadReplicaStatus;
    created_at: string;
    updated_at: string;
    last_error?: string;
}

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

const COMPUTE_TIERS: Record<string, { cpu: number; memory: string; limits: string }> = {
    micro: { cpu: 1, memory: "2g", limits: "cpu=1,mem=2g" },
    small: { cpu: 2, memory: "4g", limits: "cpu=2,mem=4g" },
    pro: { cpu: 4, memory: "8g", limits: "cpu=4,mem=8g" },
    team: { cpu: 8, memory: "16g", limits: "cpu=8,mem=16g" },
};

function nowIso(): string {
    return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeComputeState(config: Record<string, unknown>): ComputeState {
    const raw = isRecord(config.compute) ? config.compute : {};
    const tier = typeof raw.tier === "string" && COMPUTE_TIERS[raw.tier] ? raw.tier : "micro";
    const spec = COMPUTE_TIERS[tier];
    return {
        tier,
        status: raw.status === "scaling" || raw.status === "failed" ? raw.status : "active",
        cpu: typeof raw.cpu === "number" ? raw.cpu : spec.cpu,
        memory: typeof raw.memory === "string" ? raw.memory : spec.memory,
        updated_at: typeof raw.updated_at === "string" ? raw.updated_at : nowIso(),
        ...(typeof raw.last_error === "string" ? { last_error: raw.last_error } : {}),
    };
}

function normalizeReadReplicas(config: Record<string, unknown>): ReadReplicaRecord[] {
    const raw = Array.isArray(config.read_replicas) ? config.read_replicas : [];
    return raw
        .filter(isRecord)
        .map((replica): ReadReplicaRecord => ({
            id: typeof replica.id === "string" ? replica.id : crypto.randomUUID(),
            ip: typeof replica.ip === "string" ? replica.ip : "",
            region: typeof replica.region === "string" ? replica.region : "local",
            status: ["provisioning", "active", "deleting", "deleted", "failed"].includes(String(replica.status))
                ? replica.status as ReadReplicaStatus
                : "provisioning",
            created_at: typeof replica.created_at === "string" ? replica.created_at : nowIso(),
            updated_at: typeof replica.updated_at === "string" ? replica.updated_at : nowIso(),
            ...(typeof replica.last_error === "string" ? { last_error: replica.last_error } : {}),
        }))
        .filter((replica) => replica.ip);
}

function assertKnownTier(tier: string) {
    const spec = COMPUTE_TIERS[tier];
    if (!spec) {
        throw new Error(`Unknown compute tier '${tier}'. Supported tiers: ${Object.keys(COMPUTE_TIERS).join(", ")}`);
    }
    return spec;
}

function assertIpAddress(ip: string): string {
    const value = ip.trim();
    if (!/^[A-Za-z0-9.:-]+$/.test(value)) {
        throw new Error("replica_ip must be an IP address or DNS-safe host");
    }
    return value;
}

export class ScalingService {
    static listComputeTiers() {
        return Object.entries(COMPUTE_TIERS).map(([tier, spec]) => ({ tier, cpu: spec.cpu, memory: spec.memory }));
    }

    static async getScalingState(projectRef: string): Promise<{ compute: ComputeState; read_replicas: ReadReplicaRecord[] } | null> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) return null;
        const config = normalizeProjectConfig(project.config);
        return {
            compute: normalizeComputeState(config),
            read_replicas: normalizeReadReplicas(config).filter((replica) => replica.status !== "deleted"),
        };
    }

    private static async patchScalingConfig(projectRef: string, patch: Record<string, unknown>) {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error(`Project ${projectRef} not found`);
        const current = normalizeProjectConfig(project.config);
        const updated = await projectRepository.updateConfig(projectRef, { ...current, ...patch });
        if (!updated) throw new Error(`Project ${projectRef} not found`);
        return normalizeProjectConfig(updated.config);
    }

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
        const metrics = await getMetrics(nodeIp);

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
    static async verticalScale(projectRef: string, tier: string): Promise<void> {
        logger.info(`Executing vertical scaling: ${projectRef} -> ${tier}`);
        const spec = assertKnownTier(tier);
        const scalingState: ComputeState = {
            tier,
            status: "scaling",
            cpu: spec.cpu,
            memory: spec.memory,
            updated_at: nowIso(),
        };
        await this.patchScalingConfig(projectRef, { compute: scalingState });

        const { resolveDbName } = await import("../db");
        const dbName = await resolveDbName(projectRef);
        const result = await shellService.execute('ha_manager.sh', ['vertical_scale', dbName, spec.limits]);
        if (!result.success) {
            await this.patchScalingConfig(projectRef, {
                compute: {
                    ...scalingState,
                    status: "failed",
                    last_error: result.error || "compute scaling failed",
                    updated_at: nowIso(),
                },
            });
            throw new Error(result.error || "compute scaling failed");
        }

        await this.patchScalingConfig(projectRef, {
            compute: {
                ...scalingState,
                status: "active",
                updated_at: nowIso(),
            },
        });
    }

    /**
     * Horizontal scaling: Add read replica and register to gateway
     */
    static async horizontalScale(projectRef: string, replicaIp: string, region = "local"): Promise<ReadReplicaRecord> {
        logger.info(`Executing horizontal scaling: ${projectRef} adding replica ${replicaIp}`);
        const ip = assertIpAddress(replicaIp);
        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error(`Project ${projectRef} not found`);
        const config = normalizeProjectConfig(project.config);
        const replicas = normalizeReadReplicas(config).filter((replica) => replica.status !== "deleted");
        const existing = replicas.find((replica) => replica.ip === ip);
        if (existing && existing.status !== "failed") {
            throw new Error(`Read replica ${ip} already exists`);
        }

        const timestamp = nowIso();
        const record: ReadReplicaRecord = {
            id: existing?.id || crypto.randomUUID(),
            ip,
            region,
            status: "provisioning",
            created_at: existing?.created_at || timestamp,
            updated_at: timestamp,
        };
        const nextReplicas = existing
            ? replicas.map((replica) => replica.id === existing.id ? record : replica)
            : [...replicas, record];
        await projectRepository.updateConfig(projectRef, { ...config, read_replicas: nextReplicas });

        const replicaResult = await shellService.execute('ha_manager.sh', ['add_replica', ip], 10 * 60_000);
        if (!replicaResult.success) {
            const failed: ReadReplicaRecord = {
                ...record,
                status: "failed",
                updated_at: nowIso(),
                last_error: replicaResult.error || "replica initialization failed",
            };
            await projectRepository.updateConfig(projectRef, {
                ...config,
                read_replicas: nextReplicas.map((replica) => replica.id === record.id ? failed : replica),
            });
            throw new Error(replicaResult.error || "replica initialization failed");
        }

        const gatewayResult = await gatewayService.addUpstreamTarget(projectRef, ip);
        if (!gatewayResult.success) {
            const failed: ReadReplicaRecord = {
                ...record,
                status: "failed",
                updated_at: nowIso(),
                last_error: gatewayResult.error || "gateway registration failed",
            };
            await projectRepository.updateConfig(projectRef, {
                ...config,
                read_replicas: nextReplicas.map((replica) => replica.id === record.id ? failed : replica),
            });
            throw new Error(gatewayResult.error || "gateway registration failed");
        }

        const active: ReadReplicaRecord = {
            ...record,
            status: "active",
            updated_at: nowIso(),
        };
        await projectRepository.updateConfig(projectRef, {
            ...config,
            read_replicas: nextReplicas.map((replica) => replica.id === record.id ? active : replica),
        });
        return active;
    }

    static async removeReadReplica(projectRef: string, replicaId: string): Promise<ReadReplicaRecord | null> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) return null;
        const config = normalizeProjectConfig(project.config);
        const replicas = normalizeReadReplicas(config);
        const existing = replicas.find((replica) => replica.id === replicaId);
        if (!existing || existing.status === "deleted") return null;

        const deleting: ReadReplicaRecord = { ...existing, status: "deleting", updated_at: nowIso() };
        await projectRepository.updateConfig(projectRef, {
            ...config,
            read_replicas: replicas.map((replica) => replica.id === replicaId ? deleting : replica),
        });

        const gatewayResult = await gatewayService.removeUpstreamTarget(projectRef, existing.ip);
        if (!gatewayResult.success) {
            const failed: ReadReplicaRecord = {
                ...existing,
                status: "failed",
                updated_at: nowIso(),
                last_error: gatewayResult.error || "gateway removal failed",
            };
            await projectRepository.updateConfig(projectRef, {
                ...config,
                read_replicas: replicas.map((replica) => replica.id === replicaId ? failed : replica),
            });
            throw new Error(gatewayResult.error || "gateway removal failed");
        }

        const deleted: ReadReplicaRecord = { ...existing, status: "deleted", updated_at: nowIso() };
        await projectRepository.updateConfig(projectRef, {
            ...config,
            read_replicas: replicas.map((replica) => replica.id === replicaId ? deleted : replica),
        });
        return deleted;
    }
}
