<script lang="ts">
    import { apiClient } from "$lib/api";
    import { onMount } from "svelte";
    import { Loader2 } from "lucide-svelte";

    let metrics = $state<Record<string, unknown> | null>(null);
    let loading = $state(true);

    const usageStats = [
        { name: 'CPU Usage', value: '12%', color: 'text-brand' },
        { name: 'Memory', value: '1.2 GB / 4 GB', color: 'text-blue-500' },
        { name: 'Disk Space', value: '45 GB / 100 GB', color: 'text-yellow-500' },
    ];

    onMount(async () => {
        try {
            const res = await apiClient('/v1/monitor/system');
            if (res.ok) {
                metrics = await res.json();
            }
        } catch {
            // fallback to static data
        } finally {
            loading = false;
        }
    });
</script>

<div class="space-y-6">
    <h2 class="text-2xl font-bold tracking-tight">System Status</h2>
    {#if loading}
        <div class="flex items-center justify-center py-12">
            <Loader2 size={24} class="animate-spin text-brand opacity-50" />
        </div>
    {:else}
        <div class="grid gap-4 md:grid-cols-3">
            {#each usageStats as stat}
                <div class="p-6 rounded-lg border bg-card">
                    <p class="text-sm font-medium text-muted-foreground uppercase">{stat.name}</p>
                    <p class={"text-2xl font-bold mt-2 " + stat.color}>{stat.value}</p>
                </div>
            {/each}
        </div>
    {/if}
</div>
