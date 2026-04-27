<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Search, Hash, Check, X } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface DbIndex {
    schemaname: string;
    tablename: string;
    indexname: string;
    indexdef: string;
    idx_scan: number;
    idx_size: string;
    is_unique: boolean;
    am_name: string;
  }

  let searchQuery = $state("");

  const projectRef = $derived(page.params.ref);

  const INDEXES_SQL = `
    SELECT 
      s.schemaname,
      s.relname as tablename,
      s.indexrelname as indexname,
      pi.indexdef,
      COALESCE(s.idx_scan, 0)::bigint as idx_scan,
      pg_size_pretty(pg_relation_size(s.indexrelid)) as idx_size,
      ix.indisunique as is_unique,
      am.amname as am_name
    FROM pg_stat_user_indexes s
    JOIN pg_index ix ON s.indexrelid = ix.indexrelid
    JOIN pg_indexes pi ON s.indexrelname = pi.indexname AND s.schemaname = pi.schemaname
    JOIN pg_am am ON (SELECT relam FROM pg_class WHERE oid = s.indexrelid) = am.oid
    WHERE s.schemaname = 'public'
    ORDER BY s.idx_scan ASC, s.relname, s.indexrelname;
  `;

  const indexesQuery = createQuery(() => ({
    queryKey: ["database_indexes", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: INDEXES_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as DbIndex[];
    }
  }));

  const indexes = $derived((indexesQuery.data as DbIndex[]) || []);
  const isLoading = $derived(indexesQuery.isPending);
  const error = $derived(indexesQuery.error?.message || null);

  const filteredIndexes = $derived(
    searchQuery
      ? indexes.filter(i => i.indexname.toLowerCase().includes(searchQuery.toLowerCase()) || i.tablename.toLowerCase().includes(searchQuery.toLowerCase()))
      : indexes
  );

  function getScanColor(scans: number): string {
    if (scans === 0) return "text-red-500 bg-red-500/10";
    if (scans < 100) return "text-amber-500 bg-amber-500/10";
    return "text-green-500 bg-green-500/10";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("Indexes.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Indexes.subtitle")}</p>
    </div>
    {#if !isLoading}
      <span class="px-2.5 py-1 rounded-full bg-brand/10 text-brand text-xs font-bold">{indexes.length}</span>
    {/if}
  </div>

  <div class="relative w-64">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input bind:value={searchQuery} placeholder={$t("Indexes.search")} class="w-full pl-9 pr-3 py-1.5 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("Indexes.loading")}</p>
      </div>
    {:else if error}
      <div class="p-4"><div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div></div>
    {:else}
      <div class="overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Indexes.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Indexes.table")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Indexes.type")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Indexes.unique")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-right">{$t("Indexes.size")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-right">{$t("Indexes.scans")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each filteredIndexes as idx}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <Hash size={13} class="text-muted-foreground/50" />
                    <span class="font-mono font-medium text-[11px]">{idx.indexname}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 font-mono text-muted-foreground">{idx.tablename}</td>
                <td class="px-3 py-2.5">
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-muted text-muted-foreground">{idx.am_name}</span>
                </td>
                <td class="px-3 py-2.5 text-center">
                  {#if idx.is_unique}
                    <Check size={13} class="inline text-green-500" />
                  {:else}
                    <X size={13} class="inline text-muted-foreground/30" />
                  {/if}
                </td>
                <td class="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{idx.idx_size}</td>
                <td class="px-3 py-2.5 text-right">
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums {getScanColor(idx.idx_scan)}">{Number(idx.idx_scan).toLocaleString()}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
