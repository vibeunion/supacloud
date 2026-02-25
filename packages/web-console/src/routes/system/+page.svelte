<script lang="ts">
    let { data } = $props();
    const metrics = data.metrics;

    const usageStats = [
        {
            label: "CPU Usage",
            value: metrics.cpu.usage,
            total: "100%",
            color: "var(--primary-color)",
        },
        {
            label: "Memory",
            value: metrics.memory.used,
            total: metrics.memory.total,
            color: "var(--secondary-color)",
        },
        {
            label: "Disk Space",
            value: metrics.disk.used,
            total: metrics.disk.total,
            color: "var(--warning-color)",
        },
    ];
</script>

<div class="system-page">
    <header class="page-header">
        <div class="title">
            <h1>System Health</h1>
            <p>Real-time metrics from the host server.</p>
        </div>
    </header>

    <div class="metrics-overview">
        {#each usageStats as stat}
            <div class="metric-card glass">
                <div class="header">
                    <span class="label">{stat.label}</span>
                    <span class="value">{stat.value}</span>
                </div>
                <div class="progress-bg">
                    <div
                        class="progress-bar"
                        style="width: {stat.value}; background: {stat.color};"
                    ></div>
                </div>
                <div class="footer">
                    <span>0%</span>
                    <span>{stat.total}</span>
                </div>
            </div>
        {/each}
    </div>

    <div class="details-grid">
        <section class="services glass">
            <h2>Active Services</h2>
            <div class="service-list">
                {#each metrics.services as service}
                    <div class="service-item">
                        <div class="service-name">
                            <span
                                class="dot {service.status === 'running'
                                    ? 'active'
                                    : ''}"
                            ></span>
                            {service.name}
                        </div>
                        <span class="uptime">{service.uptime}</span>
                    </div>
                {/each}
            </div>
        </section>

        <section class="os-info glass">
            <h2>Server Information</h2>
            <div class="info-table">
                <div class="info-row">
                    <span class="key">OS Distro</span>
                    <span class="val">{metrics.os.distro}</span>
                </div>
                <div class="info-row">
                    <span class="key">Kernel</span>
                    <span class="val">{metrics.os.kernel}</span>
                </div>
                <div class="info-row">
                    <span class="key">Docker Version</span>
                    <span class="val">{metrics.os.docker}</span>
                </div>
                <div class="info-row">
                    <span class="key">Uptime</span>
                    <span class="val">{metrics.os.uptime}</span>
                </div>
            </div>
        </section>
    </div>
</div>

<style>
    .system-page {
        display: flex;
        flex-direction: column;
        gap: 2rem;
    }

    .metrics-overview {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 1.5rem;
    }

    .metric-card {
        padding: 1.5rem;
        border-radius: 20px;
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .metric-card .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
    }

    .metric-card .label {
        font-size: 0.95rem;
        font-weight: 500;
        color: var(--text-secondary);
    }

    .metric-card .value {
        font-size: 1.5rem;
        font-weight: 700;
    }

    .progress-bg {
        height: 8px;
        background: var(--surface-light);
        border-radius: 4px;
        overflow: hidden;
    }

    .progress-bar {
        height: 100%;
        border-radius: 4px;
        box-shadow: 0 0 10px rgba(255, 255, 255, 0.1);
    }

    .metric-card .footer {
        display: flex;
        justify-content: space-between;
        font-size: 0.8rem;
        color: var(--text-secondary);
    }

    .details-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
        gap: 1.5rem;
    }

    section {
        padding: 1.5rem;
        border-radius: 20px;
    }

    section h2 {
        font-size: 1.25rem;
        margin-bottom: 1.5rem;
    }

    .service-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .service-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 0;
        border-bottom: 1px solid var(--border-color);
    }

    .service-item:last-child {
        border-bottom: none;
    }

    .service-name {
        display: flex;
        align-items: center;
        gap: 10px;
        font-weight: 500;
    }

    .service-name .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--text-secondary);
    }

    .service-name .dot.active {
        background: var(--success-color);
        box-shadow: 0 0 8px var(--success-color);
    }

    .uptime {
        font-size: 0.85rem;
        color: var(--text-secondary);
    }

    .info-table {
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    .info-row {
        display: flex;
        justify-content: space-between;
    }

    .info-row .key {
        color: var(--text-secondary);
        font-size: 0.9rem;
    }

    .info-row .val {
        font-weight: 600;
        font-size: 0.9rem;
    }
</style>
