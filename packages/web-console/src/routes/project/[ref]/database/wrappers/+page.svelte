<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, Globe, Database, Settings, AlertTriangle } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createQuery } from "@tanstack/svelte-query";

  interface Wrapper {
    id: number;
    name: string;
    handler: string;
    validator: string;
    server: string;
    fdw_type: string;
  }

  const projectRef = $derived(page.params.ref);

  const WRAPPERS_SQL = `
    SELECT 
      f.oid::int as id,
      f.fdwname as name,
      f.fdwhandler::regproc::text as handler,
      f.fdwvalidator::regproc::text as validator,
      s.srvname as server,
      CASE 
        WHEN f.fdwname ILIKE '%postgres%' THEN 'PostgreSQL'
        WHEN f.fdwname ILIKE '%stripe%' THEN 'Stripe'
        WHEN f.fdwname ILIKE '%firebase%' THEN 'Firebase'
        WHEN f.fdwname ILIKE '%s3%' THEN 'S3'
        WHEN f.fdwname ILIKE '%clickhouse%' THEN 'ClickHouse'
        WHEN f.fdwname ILIKE '%bigquery%' THEN 'BigQuery'
        ELSE 'Custom'
      END as fdw_type
    FROM pg_foreign_data_wrapper f
    LEFT JOIN pg_foreign_server s ON s.srvfdw = f.oid
    ORDER BY f.fdwname;
  `;

  const wrappersQuery = createQuery(() => ({
    queryKey: ["database_wrappers", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: WRAPPERS_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as Wrapper[];
    }
  }));

  const wrappers = $derived((wrappersQuery.data as Wrapper[]) || []);
  const isLoading = $derived(wrappersQuery.isPending);

  function getTypeIcon(type: string): string {
    if (type === "PostgreSQL") return "🐘";
    if (type === "Stripe") return "💳";
    if (type === "Firebase") return "🔥";
    if (type === "S3") return "📦";
    if (type === "ClickHouse") return "🏠";
    if (type === "BigQuery") return "📊";
    return "🔗";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">Foreign Data Wrappers</h1>
    <p class="text-sm text-muted-foreground mt-1">使用 Wrappers 连接外部数据源，直接在 SQL 中查询第三方服务</p>
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Globe size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">Foreign Data Wrappers (FDW) 允许你将外部数据源（如 Stripe、Firebase、S3、其他 PostgreSQL 等）映射为本地表进行查询。</p>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在查询 FDW 配置...</p>
      </div>
    {:else if wrappers.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Globe size={40} class="opacity-20" />
        <p class="text-sm">暂无 Foreign Data Wrappers</p>
        <p class="text-xs">可通过 SQL 创建 FDW 来连接外部数据源</p>
      </div>
    {:else}
      <div class="overflow-auto">
        <div class="divide-y divide-border/20">
          {#each wrappers as wrapper}
            <div class="flex items-center justify-between px-5 py-4 hover:bg-muted/10 transition-colors">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-lg bg-brand/10 text-brand flex items-center justify-center text-lg">
                  {getTypeIcon(wrapper.fdw_type)}
                </div>
                <div>
                  <span class="font-semibold text-sm">{wrapper.name}</span>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase text-blue-600 bg-blue-500/10">{wrapper.fdw_type}</span>
                    {#if wrapper.server}
                      <span class="text-[10px] text-muted-foreground">→ {wrapper.server}</span>
                    {/if}
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-3 text-xs text-muted-foreground font-mono">
                <span>{wrapper.handler}</span>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
