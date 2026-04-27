<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, Database, Clock, HardDrive, Shield, Cpu } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createQuery } from "@tanstack/svelte-query";

  interface DbSetting {
    name: string;
    setting: string;
    unit: string;
    category: string;
    description: string;
  }

  const projectRef = $derived(page.params.ref);

  const SETTINGS_SQL = `
    SELECT name, setting, unit, category, short_desc as description
    FROM pg_settings
    WHERE name IN (
      'max_connections', 'shared_buffers', 'effective_cache_size',
      'work_mem', 'maintenance_work_mem', 'wal_buffers',
      'max_worker_processes', 'max_parallel_workers',
      'checkpoint_completion_target', 'default_statistics_target',
      'random_page_cost', 'effective_io_concurrency',
      'log_min_duration_statement', 'statement_timeout',
      'idle_in_transaction_session_timeout', 'lock_timeout',
      'timezone', 'lc_collate', 'server_version', 'max_locks_per_transaction'
    )
    ORDER BY category, name;
  `;

  const query = createQuery(() => ({
    queryKey: ["database_settings", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: SETTINGS_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as DbSetting[];
    }
  }));

  const settings = $derived((query.data as DbSetting[]) || []);
  const isLoading = $derived(query.isPending);

  function getCategoryIcon(cat: string): typeof Database {
    if (cat.includes("Connection")) return Database;
    if (cat.includes("Memory") || cat.includes("Resource")) return Cpu;
    if (cat.includes("Write-Ahead") || cat.includes("WAL")) return HardDrive;
    if (cat.includes("Lock") || cat.includes("Security")) return Shield;
    return Clock;
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">数据库设置</h1>
    <p class="text-sm text-muted-foreground mt-1">PostgreSQL 运行时参数和性能配置</p>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在查询 pg_settings...</p>
      </div>
    {:else if settings.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Database size={40} class="opacity-20" />
        <p class="text-sm">无法获取数据库设置</p>
      </div>
    {:else}
      <div class="overflow-auto max-h-[70vh]">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">参数</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground text-right">值</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">分类</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">说明</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20 font-mono">
            {#each settings as s}
              {@const CatIcon = getCategoryIcon(s.category)}
              <tr class="hover:bg-muted/5 transition-colors">
                <td class="px-4 py-2.5 font-semibold text-[11px]">{s.name}</td>
                <td class="px-4 py-2.5 text-right">
                  <span class="px-2 py-0.5 rounded bg-brand/10 text-brand font-bold text-[11px]">{s.setting}{s.unit ? ` ${s.unit}` : ''}</span>
                </td>
                <td class="px-4 py-2.5">
                  <span class="px-1.5 py-0.5 rounded text-[9px] text-muted-foreground bg-muted/50">{s.category}</span>
                </td>
                <td class="px-4 py-2.5 text-muted-foreground text-[10px] max-w-xs truncate" title={s.description}>{s.description}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
