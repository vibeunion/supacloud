<script lang="ts">
    let { data } = $props();
    const projects = data.projects;
</script>

<div class="projects-page">
    <header class="page-header">
        <div class="title">
            <h1>Projects</h1>
            <p>Manage your Supabase project instances.</p>
        </div>
        <button class="create-btn glow-hover">
            <span class="plus">+</span> New Project
        </button>
    </header>

    <div class="table-container glass">
        <table class="project-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Reference</th>
                    <th>Region</th>
                    <th>Status</th>
                    <th>Created At</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                {#each projects as project}
                    <tr>
                        <td><span class="name">{project.name}</span></td>
                        <td><code class="ref">{project.ref}</code></td>
                        <td><span class="region">{project.region}</span></td>
                        <td
                            ><span
                                class="status-tag {project.status.toLowerCase()}"
                                >{project.status}</span
                            ></td
                        >
                        <td
                            ><span class="date"
                                >{new Date(
                                    project.created_at,
                                ).toLocaleDateString()}</span
                            ></td
                        >
                        <td>
                            <div class="actions">
                                <button title="Settings" class="icon-btn"
                                    >⚙️</button
                                >
                                <button title="Restart" class="icon-btn"
                                    >🔄</button
                                >
                                <button title="Delete" class="icon-btn delete"
                                    >🗑️</button
                                >
                            </div>
                        </td>
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
</div>

<style>
    .projects-page {
        display: flex;
        flex-direction: column;
        gap: 2rem;
    }

    .page-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .title h1 {
        font-size: 1.8rem;
        margin-bottom: 0.25rem;
    }

    .title p {
        color: var(--text-secondary);
    }

    .create-btn {
        background: linear-gradient(
            135deg,
            var(--primary-color),
            var(--secondary-color)
        );
        color: white;
        padding: 12px 24px;
        border-radius: 12px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: var(--transition);
    }

    .plus {
        font-size: 1.2rem;
        font-weight: 700;
    }

    .table-container {
        border-radius: 20px;
        overflow: hidden;
    }

    .project-table {
        width: 100%;
        border-collapse: collapse;
        text-align: left;
    }

    .project-table th {
        padding: 1.25rem 1.5rem;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border-color);
    }

    .project-table td {
        padding: 1.25rem 1.5rem;
        border-bottom: 1px solid var(--border-color);
    }

    .project-table tr:last-child td {
        border-bottom: none;
    }

    .name {
        font-weight: 600;
    }

    .ref {
        font-family: "JetBrains Mono", monospace;
        font-size: 0.8rem;
        background: var(--surface-light);
        padding: 4px 8px;
        border-radius: 6px;
        color: var(--text-secondary);
    }

    .status-tag {
        font-size: 0.75rem;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 6px;
        text-transform: uppercase;
    }

    .status-tag.active {
        background: rgba(16, 185, 129, 0.1);
        color: var(--success-color);
    }

    .status-tag.paused {
        background: rgba(245, 158, 11, 0.1);
        color: var(--warning-color);
    }

    .date {
        font-size: 0.85rem;
        color: var(--text-secondary);
    }

    .actions {
        display: flex;
        gap: 8px;
    }

    .icon-btn {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--surface-light);
        transition: var(--transition);
        border: 1px solid var(--border-color);
    }

    .icon-btn:hover {
        border-color: var(--primary-color);
        transform: translateY(-2px);
    }

    .icon-btn.delete:hover {
        border-color: var(--error-color);
        background: rgba(239, 68, 68, 0.1);
    }
</style>
