<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, AlertTriangle, Play } from "lucide-svelte";
  import { createQuery, createMutation } from "@tanstack/svelte-query";

  interface QueryStat {
    query: string;
    calls: number;
    total_exec_time: number;
    mean_exec_time: number;
    rows: number;
  }

  const projectRef = $derived(page.params.ref);

  const statsQuery = createQuery(() => ({
    queryKey: ["query-performance", projectRef],
    queryFn: async () => {
      const extensionCheck = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed;`
        })
      });
      const extensionData = await extensionCheck.json();
      if (!extensionCheck.ok) {
        throw new Error(extensionData?.message || extensionData?.error || "Failed to check extension status");
      }
      const installed = Boolean(extensionData?.rows?.[0]?.installed);
      if (!installed) {
        throw new Error("MISSING_EXTENSION");
      }

      const schemasToTry = ['', 'monitor.', 'extensions.'];
      let lastError = null;

      for (const schemaPrefix of schemasToTry) {
        try {
          const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sql: `SELECT query, calls, total_exec_time, mean_exec_time, rows 
                    FROM ${schemaPrefix}pg_stat_statements 
                    ORDER BY total_exec_time DESC LIMIT 100;`
            })
          });
          const data = await res.json();

          if (!res.ok) {
            lastError = data;
            if (data?.message?.includes("pg_stat_statements") && data?.message?.includes("does not exist")) {
              continue;
            }
            throw new Error(data?.message || data?.error || "Failed to query pg_stat_statements");
          }
          
          if (data.error) {
            lastError = data;
            // If it's a "does not exist" error, continue to the next schema prefix
            if (data.message?.includes("pg_stat_statements") && data.message?.includes("does not exist")) {
              continue;
            } else {
              throw new Error(data.message || data.error);
            }
          }
          
          // Success
          return data.rows || [];

        } catch (err: unknown) {
          lastError = { message: (err instanceof Error ? err.message : String(err)) };
          break; // Stop on non-recoverable error
        }
      }

      if (lastError) {
         if (lastError.message?.includes("pg_stat_statements") && lastError.message?.includes("does not exist")) {
           throw new Error("MISSING_EXTENSION");
         } else {
           throw new Error(lastError instanceof Error ? lastError.message : String(lastError) || lastError.error || "Unknown error");
         }
      }

      return [];
    }
  }));

  const enableMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`,
          mode: "migration"
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return true;
    },
    onSuccess: () => {
      statsQuery.refetch();
    }
  }));

  function enableExtension() {
    enableMutation.mutate();
  }

  const stats = $derived((statsQuery.data || []) as QueryStat[]);
  const isLoading = $derived(statsQuery.isPending);
  const isEnabling = $derived(enableMutation.isPending);
  const missingExtension = $derived(statsQuery.error?.message === "MISSING_EXTENSION");
  const error = $derived(statsQuery.error && statsQuery.error.message !== "MISSING_EXTENSION" ? statsQuery.error.message : (enableMutation.error ? enableMutation.error.message : null));

  function formatMs(ms: number): string {
    if (ms < 1) return ms.toFixed(2) + " ms";
    if (ms < 1000) return ms.toFixed(1) + " ms";
    return (ms / 1000).toFixed(2) + " s";
  }

  function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num);
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center gap-3">
    <h1 class="text-2xl font-bold">{$t("QueryPerformance.title")}</h1>
  </div>
  <p class="text-sm text-muted-foreground">{$t("QueryPerformance.subtitle")}</p>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden flex flex-col">
    {#if isLoading}
      <div class="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3 py-24">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("QueryPerformance.loading")}</p>
      </div>
    {:else if error}
      <div class="p-6">
        <div class="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm font-mono">
          <strong>{$t("QueryPerformance.error")}:</strong> {error}
        </div>
      </div>
    {:else if missingExtension}
      <div class="flex-1 flex flex-col items-center justify-center text-center gap-4 py-24 max-w-md mx-auto">
        <div class="w-16 h-16 rounded-full bg-yellow-500/10 text-yellow-600 flex items-center justify-center mb-2">
          <AlertTriangle size={32} />
        </div>
        <h3 class="text-lg font-semibold">{$t("QueryPerformance.extension_required")}</h3>
        <p class="text-sm text-muted-foreground">{$t("QueryPerformance.extension_desc")}</p>
        <button 
          onclick={enableExtension}
          disabled={isEnabling}
          class="mt-4 flex items-center gap-2 px-6 py-2.5 bg-brand text-white font-medium rounded-full hover:bg-brand/90 transition-all disabled:opacity-50"
        >
          {#if isEnabling}
            <Loader2 size={16} class="animate-spin" />
            <span>Enabling...</span>
          {:else}
            <Play size={16} />
            <span>{$t("QueryPerformance.enable_now")}</span>
          {/if}
        </button>
      </div>
    {:else}
      <div class="overflow-x-auto flex-1">
        <table class="w-full text-left text-sm">
          <thead class="bg-muted/30 border-b sticky top-0 backdrop-blur-sm">
            <tr>
              <th class="px-6 py-3 font-medium text-muted-foreground w-1/2">{$t("QueryPerformance.query")}</th>
              <th class="px-6 py-3 font-medium text-muted-foreground text-right w-32">{$t("QueryPerformance.total_time")}</th>
              <th class="px-6 py-3 font-medium text-muted-foreground text-right w-32">{$t("QueryPerformance.mean_time")}</th>
              <th class="px-6 py-3 font-medium text-muted-foreground text-right w-32">{$t("QueryPerformance.calls")}</th>
              <th class="px-6 py-3 font-medium text-muted-foreground text-right w-32">{$t("QueryPerformance.rows")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/30">
            {#each stats as stat}
              <tr class="hover:bg-muted/20 transition-colors group">
                <td class="px-6 py-4">
                  <div class="font-mono text-xs text-foreground/80 break-all bg-muted/30 p-2 rounded border border-border/50 max-h-32 overflow-y-auto">
                    {stat.query}
                  </div>
                </td>
                <td class="px-6 py-4 text-right tabular-nums text-xs">
                  <span class="px-2 py-1 rounded bg-orange-500/10 text-orange-600 font-medium">
                    {formatMs(stat.total_exec_time)}
                  </span>
                </td>
                <td class="px-6 py-4 text-right tabular-nums text-muted-foreground text-xs">{formatMs(stat.mean_exec_time)}</td>
                <td class="px-6 py-4 text-right tabular-nums text-xs">{formatNumber(stat.calls)}</td>
                <td class="px-6 py-4 text-right tabular-nums text-xs text-muted-foreground">{formatNumber(stat.rows)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
