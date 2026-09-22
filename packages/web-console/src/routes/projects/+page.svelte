<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Loader2 } from "lucide-svelte";
  import { apiClient } from "$lib/api";
  import { loadProjectList, type ProjectListItem } from "$lib/project-list";

  let projects = $state<ProjectListItem[]>([]);
  let status = $state<"loading" | "ready" | "error">("loading");
  let controller: AbortController | null = null;

  async function load(): Promise<void> {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    projects = [];
    status = "loading";
    try {
      const rows = await loadProjectList(apiClient, current.signal);
      if (controller !== current) return;
      projects = rows;
      status = "ready";
    } catch {
      if (controller === current) status = "error";
    }
  }

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    controller?.abort();
  });
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <h2 class="text-2xl font-bold tracking-tight">Projects</h2>
    <div class="flex items-center gap-2">
      <button
        type="button"
        title="Refresh"
        aria-label="Refresh projects"
        onclick={() => void load()}
        class="inline-flex items-center justify-center whitespace-nowrap rounded-md border text-sm font-medium h-10 px-4 py-2"
      >
        Refresh
      </button>
      <a
        href="/projects/create"
        class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-brand text-brand-foreground hover:bg-brand/90 h-10 px-4 py-2"
      >
        New Project
      </a>
    </div>
  </div>

  {#if status === "loading"}
    <div role="status" class="flex items-center justify-center py-12">
      <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if status === "error"}
    <div class="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm" role="alert">
      <p>Projects are temporarily unavailable.</p>
      <button type="button" class="mt-2 underline" onclick={() => void load()}>Retry</button>
    </div>
  {:else if projects.length === 0}
    <div class="col-span-full py-12 text-center text-muted-foreground border rounded-lg border-dashed">
      <p>No projects found. Create your first project to get started.</p>
    </div>
  {:else}
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {#each projects as project (project.ref)}
        <a
          data-project-ref={project.ref}
          href={`/project/${project.ref}`}
          class="block p-6 rounded-lg border bg-card hover:bg-secondary/50 transition-colors"
        >
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
    </div>
  {/if}
</div>