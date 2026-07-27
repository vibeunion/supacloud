<script lang="ts">
  import { useList } from "@svadmin/core";
  import { Loader2 } from "lucide-svelte";

  const query = useList({ resource: "v1/projects" });
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-2xl font-bold tracking-tight">Projects</h2>
    <!-- CreateButton links to /projects/create automatically because resource is inferred if we were in AdminApp, but here we can just pass the path -->
    <a href="/projects/create" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-brand text-brand-foreground hover:bg-brand/90 h-10 px-4 py-2">
      New Project
    </a>
  </div>
  
  {#if query.isLoading}
    <div class="flex items-center justify-center py-12">
        <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {#each (query.data?.data || []) as project}
            <a href="/project/{project.ref}" class="block p-6 rounded-lg border bg-card hover:bg-secondary/50 transition-colors">
                <div class="flex items-center gap-2 mb-2">
                    <div class="w-2 h-2 rounded-full bg-brand"></div>
                    <span class="font-semibold">{project.name}</span>
                </div>
                <p class="text-xs text-muted-foreground font-mono">{project.ref}</p>
                <div class="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                    <span class="capitalize">{project.status}</span>
                    <span>{project.region}</span>
                </div>
            </a>
        {/each}
        {#if (query.data?.data?.length || 0) === 0}
            <div class="col-span-full py-12 text-center text-muted-foreground border rounded-lg border-dashed">
                <p>No projects found. Create your first project to get started.</p>
            </div>
        {/if}
    </div>
  {/if}
</div>
