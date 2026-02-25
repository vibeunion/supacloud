<script lang="ts">
    import Card from "$lib/components/Card.svelte";
    import { onMount } from "svelte";

    let cpuStream = $state([30, 45, 32, 60, 55, 40, 48, 52, 50, 45]);

    onMount(() => {
        const interval = setInterval(() => {
            cpuStream = [
                ...cpuStream.slice(1),
                Math.floor(Math.random() * 40) + 30,
            ];
        }, 2000);
        return () => clearInterval(interval);
    });

    const liveServices = [
        {
            name: "Auth Service",
            type: "API",
            requests: "124/m",
            latency: "42ms",
            status: "up",
        },
        {
            name: "PostgREST",
            type: "Database",
            requests: "850/m",
            latency: "12ms",
            status: "up",
        },
        {
            name: "Realtime",
            type: "Websocket",
            requests: "2.4k conn",
            latency: "5ms",
            status: "up",
        },
        {
            name: "Storage",
            type: "S3/LO",
            requests: "45/m",
            latency: "120ms",
            status: "up",
        },
        {
            name: "Edge Runtime",
            type: "Functions",
            requests: "312/m",
            latency: "180ms",
            status: "warning",
        },
    ];
</script>

<div class="monitoring-page">
    <div class="header">
        <h1>Monitoring</h1>
        <span class="live-badge">
            <span class="pulse"></span>
            Live Data
        </span>
    </div>

    <div class="main-grid">
        <Card variant="glass" class="chart-card">
            <div class="chart-header">
                <h3>Platform Requests (Global)</h3>
                <span class="value">12.4k <small>total/24h</small></span>
            </div>

            <div class="wave-chart">
                {#each cpuStream as val, i}
                    <div
                        class="bar"
                        style="height: {val}%; transition: height 1s ease;"
                    ></div>
                {/each}
            </div>
        </Card>

        <div class="service-grid">
            {#each liveServices as service}
                <Card variant="glass" class="service-card glow">
                    <div class="status-top">
                        <span class="name">{service.name}</span>
                        <span class="dot {service.status}"></span>
                    </div>
                    <div class="metrics">
                        <div class="item">
                            <span class="label">Traffic</span>
                            <span class="val">{service.requests}</span>
                        </div>
                        <div class="item">
                            <span class="label">Latency</span>
                            <span class="val">{service.latency}</span>
                        </div>
                    </div>
                </Card>
            {/each}
        </div>
    </div>

    <Card variant="glass" class="logs-section">
        <h3>Real-time Access Logs</h3>
        <div class="log-container">
            <div class="log-line">
                <span class="time">10:22:01</span>
                <span class="method get">GET</span>
                /rest/v1/users <span class="code success">200</span>
                <span class="dur">15ms</span>
            </div>
            <div class="log-line">
                <span class="time">10:22:04</span>
                <span class="method post">POST</span>
                /auth/v1/token <span class="code success">200</span>
                <span class="dur">124ms</span>
            </div>
            <div class="log-line">
                <span class="time">10:22:05</span>
                <span class="method get">GET</span>
                /rest/v1/posts <span class="code success">200</span>
                <span class="dur">8ms</span>
            </div>
            <div class="log-line">
                <span class="time">10:22:08</span>
                <span class="method patch">PATCH</span>
                /rest/v1/settings <span class="code error">403</span>
                <span class="dur">4ms</span>
            </div>
            <div class="log-line">
                <span class="time">10:22:10</span>
                <span class="method get">GET</span>
                /storage/v1/object/public/avatar.png
                <span class="code success">200</span>
                <span class="dur">240ms</span>
            </div>
        </div>
    </Card>
</div>

<style>
    .monitoring-page {
        display: flex;
        flex-direction: column;
        gap: 2rem;
    }

    .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .live-badge {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 14px;
        background: rgba(16, 185, 129, 0.1);
        color: var(--success-color);
        border-radius: 20px;
        font-size: 0.85rem;
        font-weight: 600;
    }

    .pulse {
        width: 8px;
        height: 8px;
        background: var(--success-color);
        border-radius: 50%;
        animation: pulse 2s infinite;
    }

    @keyframes pulse {
        0% {
            transform: scale(1);
            opacity: 1;
        }
        50% {
            transform: scale(1.5);
            opacity: 0.5;
        }
        100% {
            transform: scale(1);
            opacity: 1;
        }
    }

    .main-grid {
        display: grid;
        grid-template-columns: 2fr 1.2fr;
        gap: 1.5rem;
    }

    .chart-card {
        height: 400px;
        display: flex;
        flex-direction: column;
    }

    .chart-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 2rem;
    }

    .chart-header .value {
        font-size: 1.5rem;
        font-weight: 700;
    }

    .chart-header small {
        font-size: 0.8rem;
        color: var(--text-secondary);
        font-weight: 400;
    }

    .wave-chart {
        flex: 1;
        display: flex;
        align-items: flex-end;
        gap: 10px;
        padding-bottom: 1rem;
    }

    .bar {
        flex: 1;
        background: linear-gradient(
            to top,
            var(--primary-color),
            var(--secondary-color)
        );
        border-top-left-radius: 8px;
        border-top-right-radius: 8px;
        opacity: 0.8;
    }

    .service-grid {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .service-card {
        padding: 1.25rem !important;
    }

    .status-top {
        display: flex;
        justify-content: space-between;
        margin-bottom: 1rem;
    }

    .status-top .name {
        font-weight: 600;
        font-size: 0.95rem;
    }

    .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
    }

    .dot.up {
        background: var(--success-color);
        box-shadow: 0 0 8px var(--success-color);
    }
    .dot.warning {
        background: var(--warning-color);
        box-shadow: 0 0 8px var(--warning-color);
    }

    .metrics {
        display: flex;
        gap: 1.5rem;
    }

    .item {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .item .label {
        font-size: 0.75rem;
        color: var(--text-secondary);
    }

    .item .val {
        font-size: 0.9rem;
        font-weight: 600;
    }

    .log-container {
        margin-top: 1rem;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 12px;
        padding: 1rem;
        font-family: "JetBrains Mono", monospace;
        font-size: 0.85rem;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .log-line {
        display: flex;
        gap: 1rem;
    }

    .log-line .time {
        color: var(--text-secondary);
    }
    .log-line .method {
        font-weight: 700;
        width: 45px;
    }
    .log-line .method.get {
        color: #60a5fa;
    }
    .log-line .method.post {
        color: #34d399;
    }
    .log-line .method.patch {
        color: #fbbf24;
    }
    .log-line .code.success {
        color: var(--success-color);
    }
    .log-line .code.error {
        color: var(--error-color);
    }
    .log-line .dur {
        margin-left: auto;
        color: var(--text-secondary);
    }

    @media (max-width: 1024px) {
        .main-grid {
            grid-template-columns: 1fr;
        }
    }
</style>
