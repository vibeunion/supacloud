<script lang="ts">
    const stats = [
        {
            label: "Total Projects",
            value: "12",
            trend: "+2 this month",
            icon: "📁",
        },
        { label: "Active Users", value: "1.2k", trend: "+12%", icon: "👤" },
        { label: "CPU Usage", value: "24%", trend: "Healthy", icon: "⚡" },
        { label: "Storage", value: "45.2 GB", trend: "Of 100 GB", icon: "💾" },
    ];

    const recentProjects = [
        {
            name: "Ecommerce Pro",
            ref: "ecom-abc",
            status: "Active",
            region: "us-east-1",
        },
        {
            name: "Auth API",
            ref: "auth-xyz",
            status: "Active",
            region: "local",
        },
        {
            name: "Blog Engine",
            ref: "blog-123",
            status: "Paused",
            region: "local",
        },
    ];
</script>

<div class="overview">
    <section class="welcome">
        <h1>Welcome back, Admin</h1>
        <p>Here's what's happening with your SupaCloud platform today.</p>
    </section>

    <div class="stats-grid">
        {#each stats as stat}
            <div class="stat-card glass glow-hover">
                <div class="stat-header">
                    <span class="label">{stat.label}</span>
                    <span class="icon">{stat.icon}</span>
                </div>
                <div class="value">{stat.value}</div>
                <div class="trend">{stat.trend}</div>
            </div>
        {/each}
    </div>

    <section class="projects-section">
        <div class="section-header">
            <h2>Recent Projects</h2>
            <a href="/projects" class="view-all">View All →</a>
        </div>

        <div class="project-list">
            {#each recentProjects as project}
                <div class="project-item glass">
                    <div class="project-info">
                        <span class="project-name">{project.name}</span>
                        <span class="project-ref">{project.ref}</span>
                    </div>
                    <div class="project-meta">
                        <span class="region">{project.region}</span>
                        <span class="status {project.status.toLowerCase()}"
                            >{project.status}</span
                        >
                    </div>
                    <button class="action-btn">Manage</button>
                </div>
            {/each}
        </div>
    </section>
</div>

<style>
    .overview {
        display: flex;
        flex-direction: column;
        gap: 2.5rem;
    }

    .welcome h1 {
        font-size: 2rem;
        margin-bottom: 0.5rem;
    }

    .welcome p {
        color: var(--text-secondary);
    }

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 1.5rem;
    }

    .stat-card {
        padding: 1.5rem;
        border-radius: 20px;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        cursor: default;
    }

    .stat-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .stat-header .label {
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--text-secondary);
    }

    .stat-header .icon {
        font-size: 1.25rem;
        opacity: 0.8;
    }

    .stat-card .value {
        font-size: 1.75rem;
        font-weight: 700;
    }

    .stat-card .trend {
        font-size: 0.85rem;
        color: var(--success-color);
    }

    .projects-section {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .view-all {
        font-size: 0.9rem;
        color: var(--primary-color);
        font-weight: 600;
    }

    .project-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .project-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1rem 1.5rem;
        border-radius: 16px;
        transition: var(--transition);
    }

    .project-item:hover {
        background: var(--surface-light);
    }

    .project-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 250px;
    }

    .project-name {
        font-weight: 600;
    }

    .project-ref {
        font-size: 0.8rem;
        color: var(--text-secondary);
        font-family: monospace;
    }

    .project-meta {
        display: flex;
        align-items: center;
        gap: 2rem;
        flex: 1;
    }

    .region {
        font-size: 0.9rem;
        color: var(--text-secondary);
    }

    .status {
        font-size: 0.8rem;
        font-weight: 600;
        padding: 4px 12px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.05);
    }

    .status.active {
        color: var(--success-color);
        background: rgba(16, 185, 129, 0.1);
    }

    .status.paused {
        color: var(--warning-color);
        background: rgba(245, 158, 11, 0.1);
    }

    .action-btn {
        padding: 8px 16px;
        border-radius: 8px;
        background: var(--surface-light);
        color: white;
        font-weight: 500;
        border: 1px solid var(--border-color);
        transition: var(--transition);
    }

    .action-btn:hover {
        border-color: var(--primary-color);
        color: var(--primary-color);
    }
</style>
