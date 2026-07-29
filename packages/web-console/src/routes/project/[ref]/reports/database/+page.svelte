<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, ArrowLeft, HardDrive } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  const projectRef = $derived(page.params.ref);

  const dbStatsQuery = createQuery(() => ({
    queryKey: ["database-stats", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT
            datname,
            numbackends as connections,
            xact_commit as commits,
            xact_rollback as rollbacks,
            blks_read,
            blks_hit,
            CASE WHEN blks_hit + blks_read > 0
              THEN round(100.0 * blks_hit / (blks_hit + blks_read), 2)
              ELSE 0 END as cache_hit_ratio,
            pg_size_pretty(pg_database_size(datname)) as db_size
          FROM pg_stat_database
          WHERE datname = current_database();`
        })
      });
      if (!res.ok) throw new Error("Failed to fetch DB stats");
      const data = await res.json();
      const dbStatsData = data.rows || [];

      const res2 = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT
            schemaname,
            relname as table_name,
            n_live_tup as live_rows,
            n_dead_tup as dead_rows,
            n_tup_ins as inserts,
            n_tup_upd as updates,
            n_tup_del as deletes,
            seq_scan,
            idx_scan,
            pg_size_pretty(pg_total_relation_size(relid)) as total_size
          FROM pg_stat_user_tables
          ORDER BY n_live_tup DESC LIMIT 30;`
        })
      });
      if (!res2.ok) throw new Error("Failed to fetch table stats");
      const data2 = await res2.json();
      const tableStatsData = data2.rows || [];

      return { dbStats: dbStatsData, tableStats: tableStatsData };
    }
  }));

  const dbStats = $derived(dbStatsQuery.data?.dbStats || []);
  const tableStats = $derived(dbStatsQuery.data?.tableStats || []);
  const isLoading = $derived(dbStatsQuery.isPending);



  function formatNum(n: unknown): string {
    return new Intl.NumberFormat().format(Number(n) || 0);
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center gap-3">
    <a href={`/project/${projectRef}/reports`} class="p-2 hover:bg-muted/50 rounded-lg transition-colors">
      <ArrowLeft size={18} />
    </a>
    <div>
      <h1 class="text-2xl font-bold">{$t("Reports.database_report_title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Reports.database_report_subtitle")}</p>
    </div>
  </div>

  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    {#if dbStats.length > 0}
      {@const db = dbStats[0]}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">{$t("Reports.database_size")}</div>
          <div class="text-xl font-bold mt-1 text-brand">{db.db_size}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">{$t("Reports.active_connections")}</div>
          <div class="text-xl font-bold mt-1">{db.connections}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">{$t("Reports.cache_hit_ratio")}</div>
          <div class="text-xl font-bold mt-1 {Number(db.cache_hit_ratio) > 95 ? 'text-green-600' : Number(db.cache_hit_ratio) > 80 ? 'text-amber-600' : 'text-red-600'}">
            {db.cache_hit_ratio}%
          </div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">{$t("Reports.commits_rollbacks")}</div>
          <div class="text-lg font-bold mt-1">{formatNum(db.commits)} / <span class="text-red-600">{formatNum(db.rollbacks)}</span></div>
        </div>
      </div>
    {/if}

    <!-- Table Stats -->
    <div class="flex-1 rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h2 class="text-sm font-semibold flex items-center gap-2"><HardDrive size={14} /> {$t("Reports.table_stats_top")}</h2>
      </div>
      <div class="overflow-auto max-h-[55vh]">
        <table class="w-full text-left text-xs">
          <thead class="bg-card border-b sticky top-0 z-10">
            <tr>
              <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.schema")}</th>
              <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.table")}</th>
              <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.rows")}</th>
              <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.size")}</th>
              <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.inserts")}</th>
              <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.updates")}</th>
              <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.deletes")}</th>
              <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.sequential_scans")}</th>
              <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.index_scans")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20 font-mono">
            {#each tableStats as t}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2 text-muted-foreground">{t.schemaname}</td>
                <td class="px-4 py-2 font-semibold">{t.table_name}</td>
                <td class="px-4 py-2 text-right tabular-nums">{formatNum(t.live_rows)}</td>
                <td class="px-4 py-2 text-right">{t.total_size}</td>
                <td class="px-4 py-2 text-right tabular-nums text-green-600">{formatNum(t.inserts)}</td>
                <td class="px-4 py-2 text-right tabular-nums text-amber-600">{formatNum(t.updates)}</td>
                <td class="px-4 py-2 text-right tabular-nums text-red-600">{formatNum(t.deletes)}</td>
                <td class="px-4 py-2 text-right tabular-nums {Number(t.seq_scan) > 1000 ? 'text-red-600 font-bold' : ''}">{formatNum(t.seq_scan)}</td>
                <td class="px-4 py-2 text-right tabular-nums">{formatNum(t.idx_scan)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>
