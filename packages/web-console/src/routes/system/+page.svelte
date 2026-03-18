<script lang="ts">
    let { data } = $props();
    let metrics = $derived(data.metrics);

    const usageStats = [
        { name: 'CPU Usage', value: '12%', color: 'text-brand' },
        { name: 'Memory', value: '1.2 GB / 4 GB', color: 'text-blue-500' },
        { name: 'Disk Space', value: '45 GB / 100 GB', color: 'text-yellow-500' },
    ];
</script>

<div class="space-y-6">
    <h2 class="text-2xl font-bold tracking-tight">System Status</h2>
    <div class="grid gap-4 md:grid-cols-3">
        {#each usageStats as stat}
            <div class="p-6 rounded-lg border bg-card">
                <p class="text-sm font-medium text-muted-foreground uppercase">{stat.name}</p>
                <p class={"text-2xl font-bold mt-2 " + stat.color}>{stat.value}</p>
            </div>
        {/each}
    </div>
</div>
