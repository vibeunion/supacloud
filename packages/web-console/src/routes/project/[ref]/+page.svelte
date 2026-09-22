<script lang="ts">
  import { apiClient } from "$lib/api";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { RefreshCw, Loader2, Database, Users, HardDrive, ListChecks, Code2, Activity } from "lucide-svelte";
  import {
    loadProjectOverview,
    validOverviewProject,
    type ProjectOverview,
  } from "$lib/project-overview";
  import { loadServiceControlState, type ServiceControlState } from "$lib/project-services";

  const projectRef = $derived(page.params.ref);

  let overview = $state<ProjectOverview | null>(null);
  let services = $state<ServiceControlState | null>(null);
  let error = $state(false);
  let loading = $state(false);
  let revision = $state(0);
  let controller: AbortController | null = null;

  $effect(() => {
    const ref = projectRef;
    void revision;
    controller?.abort();
    const next = new AbortController();
    controller = next;
    overview = null;
    services = null;
    error = false;
    loading = false;
    if (!ref || !validOverviewProject(ref)) return () => next.abort();
    loading = true;
    void Promise.all([
      loadProjectOverview(ref, apiClient, next.signal),
      loadServiceControlState(ref, apiClient, next.signal).catch(() => null),
    ])
      .then(([summary, control]) => {
        if (next.signal.aborted) return;
        overview = summary;
        services = control;
      })
      .catch(() => {
        if (!next.signal.aborted) error = true;
      })
      .finally(() => {
        if (!next.signal.aborted) loading = false;
      });
    return () => next.abort();
  });

  const database = $derived(overview?.database ?? null);
  const tasks = $derived(overview?.tasks ?? null);
  const storage = $derived(overview?.storage ?? null);
  const functions = $derived(overview?.functions ?? null);
  const auth = $derived(overview?.auth ?? null);
  const unavailable = $derived(
    overview !== null
      && (database === null || tasks === null || storage === null || (auth?.source === "local" && auth.total_users === null)),
  );

  function refresh() {
    revision += 1;
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Project overview</h1>
      <p class="text-sm text-muted-foreground mt-1">Health and key metrics for this project</p>
    </div>
    <button
      type="button"
      aria-label="Refresh"
      onclick={refresh}
      disabled={loading}
      class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-muted/50 disabled:opacity-50"
    >
      {#if loading}<Loader2 size={14} class="animate-spin" />{:else}<RefreshCw size={14} />{/if}
      Refresh
    </button>
  </div>

  {#if error}
    <div role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600">
      Project overview is temporarily unavailable.
    </div>
  {:else if overview}
    <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground text-xs"><Database size={14} /> Database</div>
        <span data-metric="database" class="mt-2 block text-xl font-semibold">{database?.size ?? "-"}</span>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground text-xs"><Activity size={14} /> Connections</div>
        <span data-metric="connections" class="mt-2 block text-xl font-semibold">{database?.connections ?? "-"}</span>
      </div>
      {#if auth?.source === "local"}
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-muted-foreground text-xs"><Users size={14} /> Users</div>
          <span data-metric="users" class="mt-2 block text-xl font-semibold">{auth.total_users ?? "-"}</span>
        </div>
      {:else if auth?.source === "supauth"}
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-muted-foreground text-xs"><Users size={14} /> Auth</div>
          <a
            href={resolve("/project/[ref]/auth", { ref: auth.managed_by_ref ?? "" })}
            class="mt-2 block text-sm font-semibold text-brand hover:underline"
          >Managed by SupAuth</a>
        </div>
      {:else}
        <div class="rounded-xl border bg-card p-4">
          <div class="flex items-center gap-2 text-muted-foreground text-xs"><Users size={14} /> Auth</div>
          <span class="mt-2 block text-sm font-semibold">External Auth</span>
        </div>
      {/if}
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground text-xs"><ListChecks size={14} /> Tasks</div>
        <span data-metric="tasks" class="mt-2 block text-xl font-semibold">{tasks?.running ?? "-"}</span>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground text-xs"><HardDrive size={14} /> Storage</div>
        <span data-metric="storage" class="mt-2 block text-xl font-semibold">{storage?.size ?? "-"}</span>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground text-xs"><Code2 size={14} /> Functions</div>
        <span data-metric="functions" class="mt-2 block text-xl font-semibold">{functions?.count ?? "-"}</span>
      </div>
    </div>

    {#if unavailable}
      <p class="text-xs text-muted-foreground">Data unavailable for one or more sections.</p>
    {/if}

    {#if services}
      <div class="rounded-xl border bg-card p-4">
        <h2 class="text-sm font-semibold">Services</h2>
        <div class="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2">
          {#each services.services as service (service.id)}
            <div class="flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
              <span class="font-mono">{service.id}</span>
              <span class:opacity-60={!service.healthy}>{service.status}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>