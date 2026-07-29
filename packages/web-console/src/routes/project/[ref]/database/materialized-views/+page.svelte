<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { createMutation, createQuery } from "@tanstack/svelte-query";
  import { Loader2, Plus, RefreshCw, Trash2, Layers } from "lucide-svelte";
  import { t } from "svelte-i18n";
  import { toast } from "svelte-sonner";

  interface MaterializedView {
    schemaname: string;
    matviewname: string;
    matviewowner?: string;
    hasindexes: boolean;
    ispopulated: boolean;
    definition: string;
    total_bytes?: number;
  }

  const projectRef = $derived(page.params.ref);

  let name = $state("");
  let schema = $state("public");
  let definition = $state("select 1 as value");
  let withData = $state(true);

  const viewsQuery = createQuery(() => ({
    queryKey: ["materialized-views", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/materialized-views`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || $t("MaterializedViews.load_failed"));
      return (Array.isArray(data) ? data : []) as MaterializedView[];
    }
  }));

  const createViewMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/materialized-views`, {
        method: "POST",
        body: JSON.stringify({ schema, name, definition, withData })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || $t("MaterializedViews.create_failed"));
      return data;
    },
    onSuccess: () => {
      toast.success($t("MaterializedViews.create_success"));
      name = "";
      viewsQuery.refetch();
    }
  }));

  const refreshMutation = createMutation(() => ({
    mutationFn: async ({ schemaname, matviewname }: MaterializedView) => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/materialized-views/${schemaname}/${matviewname}/refresh`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || $t("MaterializedViews.refresh_failed"));
      return data;
    },
    onSuccess: () => {
      toast.success($t("MaterializedViews.refresh_success"));
      viewsQuery.refetch();
    }
  }));

  const deleteMutation = createMutation(() => ({
    mutationFn: async ({ schemaname, matviewname }: MaterializedView) => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/materialized-views/${schemaname}/${matviewname}?if_exists=true`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || $t("MaterializedViews.delete_failed"));
      return data;
    },
    onSuccess: () => {
      toast.success($t("MaterializedViews.delete_success"));
      viewsQuery.refetch();
    }
  }));

  const views = $derived((viewsQuery.data || []) as MaterializedView[]);
  const error = $derived(
    viewsQuery.error?.message ||
    createViewMutation.error?.message ||
    refreshMutation.error?.message ||
    deleteMutation.error?.message ||
    null
  );

  function formatBytes(value: number | undefined): string {
    if (!value) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">{$t("MaterializedViews.title")}</h1>
    <p class="text-sm text-muted-foreground mt-1">{$t("MaterializedViews.subtitle")}</p>
  </div>

  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
    <div class="rounded-xl border bg-card overflow-hidden min-h-[360px]">
      <div class="border-b px-5 py-4 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Layers size={16} class="text-brand" />
          <span class="font-semibold text-sm">{$t("MaterializedViews.list")}</span>
        </div>
        <button onclick={() => viewsQuery.refetch()} class="p-2 rounded-md border hover:bg-muted/50" title={$t("MaterializedViews.refresh_list")}>
          <RefreshCw size={14} />
        </button>
      </div>

      {#if viewsQuery.isPending}
        <div class="h-64 flex items-center justify-center text-muted-foreground">
          <Loader2 size={28} class="animate-spin" />
        </div>
      {:else if views.length === 0}
        <div class="h-64 flex items-center justify-center text-sm text-muted-foreground">
          {$t("MaterializedViews.empty")}
        </div>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-muted/30 border-b">
              <tr>
                <th class="px-4 py-3 text-left font-medium text-muted-foreground">{$t("MaterializedViews.name")}</th>
                <th class="px-4 py-3 text-left font-medium text-muted-foreground">{$t("MaterializedViews.status")}</th>
                <th class="px-4 py-3 text-right font-medium text-muted-foreground">{$t("MaterializedViews.size")}</th>
                <th class="px-4 py-3 text-right font-medium text-muted-foreground">{$t("MaterializedViews.action")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/40">
              {#each views as view (`${view.schemaname}.${view.matviewname}`)}
                <tr class="hover:bg-muted/20">
                  <td class="px-4 py-3">
                    <div class="font-mono text-xs">{view.schemaname}.{view.matviewname}</div>
                    <div class="text-[11px] text-muted-foreground truncate max-w-md">{view.definition}</div>
                  </td>
                  <td class="px-4 py-3">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold {view.ispopulated ? 'bg-green-500/10 text-green-600' : 'bg-amber-500/10 text-amber-600'}">
                      {view.ispopulated ? $t("MaterializedViews.populated") : $t("MaterializedViews.not_populated")}
                    </span>
                  </td>
                  <td class="px-4 py-3 text-right font-mono text-xs">{formatBytes(view.total_bytes)}</td>
                  <td class="px-4 py-3">
                    <div class="flex justify-end gap-2">
                      <button onclick={() => refreshMutation.mutate(view)} class="p-2 rounded-md border hover:bg-muted/50" title={$t("MaterializedViews.refresh")}>
                        <RefreshCw size={14} />
                      </button>
                      <button onclick={() => deleteMutation.mutate(view)} class="p-2 rounded-md border text-destructive hover:bg-destructive/10" title={$t("MaterializedViews.delete")}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-4">
        <h2 class="font-semibold text-sm flex items-center gap-2"><Plus size={16} /> {$t("MaterializedViews.new")}</h2>
      </div>
      <form class="p-5 space-y-4" onsubmit={(event) => { event.preventDefault(); createViewMutation.mutate(); }}>
        <label class="block space-y-1.5">
          <span class="text-xs font-medium text-muted-foreground">{$t("MaterializedViews.schema")}</span>
          <input bind:value={schema} class="w-full px-3 py-2 rounded-md border bg-background text-sm font-mono" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-xs font-medium text-muted-foreground">{$t("MaterializedViews.name")}</span>
          <input bind:value={name} class="w-full px-3 py-2 rounded-md border bg-background text-sm font-mono" placeholder={$t("MaterializedViews.name_placeholder")} />
        </label>
        <label class="block space-y-1.5">
          <span class="text-xs font-medium text-muted-foreground">{$t("MaterializedViews.definition")}</span>
          <textarea bind:value={definition} rows="8" class="w-full px-3 py-2 rounded-md border bg-background text-xs font-mono resize-y"></textarea>
          <p class="text-[11px] text-muted-foreground">{$t("MaterializedViews.definition_help")}</p>
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={withData} class="rounded border" />
          {$t("MaterializedViews.with_data")}
        </label>
        {#if error}
          <div class="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">{error}</div>
        {/if}
        <button disabled={createViewMutation.isPending || !name.trim() || !definition.trim()} class="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-brand text-white text-sm font-medium disabled:opacity-50">
          {#if createViewMutation.isPending}
            <Loader2 size={14} class="animate-spin" />
          {:else}
            <Plus size={14} />
          {/if}
          {$t("MaterializedViews.create")}
        </button>
      </form>
    </div>
  </div>
</div>
