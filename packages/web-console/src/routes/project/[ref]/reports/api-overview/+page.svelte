<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Activity, ArrowLeft } from "lucide-svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";
  import MetricBlock from "@svadmin/ui/components/content/MetricBlock.svelte";
  import StatusBadge from "@svadmin/ui/components/content/StatusBadge.svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface ApiStat {
    total_requests: number;
    avg_latency_ms: number;
    error_rate: number;
    status_2xx: number;
    status_4xx: number;
    status_5xx: number;
  }

  const projectRef = $derived(page.params.ref);

  const statsQuery = createQuery(() => ({
    queryKey: ["api-overview", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT
            count(*) as total_requests,
            round(avg(extract(epoch from (clock_timestamp() - now())) * 1000)::numeric, 2) as avg_response_ms
          FROM pg_stat_activity
          WHERE backend_type = 'client backend'
            AND state IS NOT NULL;`
        })
      });
      if (!res.ok) throw new Error("Failed to fetch stats");
      const data = await res.json();
      const rows = data.rows || [];
      
      let statsObj: ApiStat | null = null;
      if (rows.length > 0) {
        statsObj = {
          total_requests: parseInt(rows[0].total_requests || "0"),
          avg_latency_ms: parseFloat(rows[0].avg_response_ms || "0"),
          error_rate: 0,
          status_2xx: 0,
          status_4xx: 0,
          status_5xx: 0,
        };
      }

      const res2 = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT pid, usename, application_name, client_addr, state, query, backend_start::text, query_start::text
                FROM pg_stat_activity
                WHERE backend_type = 'client backend'
                ORDER BY backend_start DESC LIMIT 20;`
        })
      });
      if (!res2.ok) throw new Error("Failed to fetch active connections");
      const data2 = await res2.json();
      const recentReqs: Record<string, unknown>[] = data2.rows || [];

      return { stats: statsObj, recentRequests: recentReqs };
    }
  }));

  const stats = $derived(statsQuery.data?.stats || null);
  const recentRequests = $derived(statsQuery.data?.recentRequests || []);
  const isLoading = $derived(statsQuery.isPending);

  function connectionStateLabel(state: unknown): string {
    if (state === "active") return $t("Reports.connection_active");
    if (state === "idle") return $t("Reports.connection_idle");
    return state ? String(state) : "-";
  }
</script>


<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center gap-3">
    <a href={`/project/${projectRef}/reports`} class="p-2 hover:bg-muted/50 rounded-lg transition-colors">
      <ArrowLeft size={18} />
    </a>
    <div>
      <h1 class="text-2xl font-bold">{$t("Reports.api_overview")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Reports.api_overview_subtitle")}</p>
    </div>
  </div>

  {#if isLoading}
    <DataState state="loading" class="flex-1" />
  {:else}
    <!-- Stats Cards -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <MetricBlock label={$t("Reports.active_connections")} value={stats?.total_requests || 0} />
      <MetricBlock label={$t("Reports.average_latency")} value={`${stats?.avg_latency_ms?.toFixed(1) || "0"} ms`} />
      <MetricBlock label={$t("Reports.status")} value={$t("Reports.healthy")} trendTone="positive" />
      <MetricBlock label={$t("Reports.uplink_bandwidth")} value="-" />
    </div>

    <!-- Active Connections Table -->
    <div class="flex-1 rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h2 class="text-sm font-semibold flex items-center gap-2"><Activity size={14} /> {$t("Reports.current_connections")}</h2>
      </div>
      {#if recentRequests.length === 0}
        <DataState state="empty" title={$t("Reports.no_active_connections")} class="m-4" />
      {:else}
        <div class="overflow-auto max-h-[55vh]">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b sticky top-0">
              <tr>
                <th class="px-4 py-2 font-semibold text-muted-foreground">PID</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.user")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.application")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.status")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.query")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20 font-mono">
              {#each recentRequests as req}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2">{req.pid}</td>
                  <td class="px-4 py-2">{req.usename || '-'}</td>
                  <td class="px-4 py-2 text-[10px]">{req.application_name || '-'}</td>
                  <td class="px-4 py-2">
                    <StatusBadge
                      status={req.state === "active" ? "success" : req.state === "idle" ? "neutral" : "warning"}
                      label={connectionStateLabel(req.state)}
                    />
                  </td>
                  <td class="px-4 py-2 text-[10px] truncate max-w-xs text-muted-foreground" title={String(req.query || "")}>{req.query || '-'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>
