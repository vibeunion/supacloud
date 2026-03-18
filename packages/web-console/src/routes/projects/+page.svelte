<script lang="ts">
    let { data } = $props();
    let projects = $derived(data.projects);
</script>

<div class="space-y-6">
    <h2 class="text-2xl font-bold tracking-tight">Projects</h2>
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {#each projects as project}
            <a href="/dashboard?ref={project.ref}" class="block p-6 rounded-lg border bg-card hover:bg-secondary/50 transition-colors">
                <div class="flex items-center gap-2 mb-2">
                    <div class="w-2 h-2 rounded-full bg-brand"></div>
                    <span class="font-semibold">{project.name}</span>
                </div>
                <p class="text-xs text-muted-foreground font-mono">{project.ref}</p>
            </a>
        {/each}
    </div>
</div>
