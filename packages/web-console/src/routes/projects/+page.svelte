<script lang="ts">
    import { apiClient } from "$lib/api";
    import { onMount } from "svelte";
    import { Loader2 } from "lucide-svelte";

    let projects = $state<Record<string, unknown>[]>([]);
    let loading = $state(true);

    onMount(async () => {
        try {
            const res = await apiClient('/v1/projects');
            if (res.ok) {
                projects = await res.json();
            }
        } catch {
            // handled by apiClient 401 redirect
        } finally {
            loading = false;
        }
    });
</script>

<div class="space-y-6">
    <h2 class="text-2xl font-bold tracking-tight">Projects</h2>
    {#if loading}
        <div class="flex items-center justify-center py-12">
            <Loader2 size={24} class="animate-spin text-brand opacity-50" />
        </div>
    {:else}
        <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {#each projects as project}
                <a href="/project/{project.ref}" class="block p-6 rounded-lg border bg-card hover:bg-secondary/50 transition-colors">
                    <div class="flex items-center gap-2 mb-2">
                        <div class="w-2 h-2 rounded-full bg-brand"></div>
                        <span class="font-semibold">{project.name}</span>
                    </div>
                    <p class="text-xs text-muted-foreground font-mono">{project.ref}</p>
                </a>
            {/each}
        </div>
    {/if}
</div>
