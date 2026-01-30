export interface HealthStatus {
    status: 'up' | 'down' | 'unreachable';
    role: 'primary' | 'replica' | 'unknown';
    node: string;
    timestamp: string;
}

export interface MetricQueryResponse {
    metric: string;
    value: number;
    unit: string;
}

export interface NodeMetrics {
    qps: number;
    active_connections: number;
    slow_queries: number;
    cpu_usage?: number;
    mem_usage?: number;
}
