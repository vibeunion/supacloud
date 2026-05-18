<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { Loader2, Activity, RefreshCw, Trash2, AlertTriangle, Wifi, WifiOff } from "lucide-svelte";
  import { locale } from "svelte-i18n";

  interface PoolInfo {
    database: string;
    user: string;
    cl_active: string;
    cl_waiting: string;
    sv_active: string;
    sv_idle: string;
    sv_used: string;
    pool_mode: string;
  }

  interface ClientInfo {
    type: string;
    user: string;
    database: string;
    state: string;
    addr: string;
    port: string;
    connect_time: string;
  }

  let pools: PoolInfo[] = $state.raw([]);
  let clients: ClientInfo[] = $state.raw([]);
  let isLoading = $state(true);
  let actionMsg: string | null = $state.raw(null);
  const isZh = $derived(($locale ?? "").toLowerCase().startsWith("zh"));
  const tr = (zh: string, en: string) => isZh ? zh : en;

  async function runBouncerSql(sql: string): Promise<Record<string, unknown>[]> {
    try {
      // Query pgbouncer admin port via management API SQL endpoint
      const res = await apiClient("/v1/projects/default/database/sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql })
      });
      const data = await res.json();
      return data.rows || [];
    } catch { return []; }
  }

  async function fetchDiagnostics() {
    isLoading = true;
    // Try SHOW POOLS and SHOW CLIENTS (these work when connected to pgbouncer admin db)
    // Fallback: query pg_stat_activity for connection diagnostics
    const [poolData, clientData] = await Promise.all([
      runBouncerSql(`SELECT 
        datname as database, usename as "user", 
        count(*) FILTER (WHERE state = 'active') as cl_active,
        count(*) FILTER (WHERE wait_event IS NOT NULL AND state != 'active') as cl_waiting,
        count(*) FILTER (WHERE state = 'idle') as sv_idle,
        count(*) as sv_used,
        count(*) FILTER (WHERE state = 'active') as sv_active,
        'transaction' as pool_mode
        FROM pg_stat_activity WHERE backend_type = 'client backend'
        GROUP BY datname, usename;`),
      runBouncerSql(`SELECT 
        'client' as type, usename as "user", datname as database, 
        state, client_addr as addr, client_port::text as port,
        backend_start::text as connect_time
        FROM pg_stat_activity WHERE backend_type = 'client backend'
        ORDER BY backend_start DESC LIMIT 50;`)
    ]);
    pools = poolData as unknown as PoolInfo[];
    clients = clientData as unknown as ClientInfo[];
    isLoading = false;
  }

  async function killIdleConnections() {
    if (!confirm(tr("确定要断开所有空闲连接吗？这不会影响正在执行查询的连接。", "Disconnect all idle connections? This will not affect currently executing queries."))) return;
    actionMsg = null;
    try {
      const result = await runBouncerSql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND backend_type = 'client backend' AND pid != pg_backend_pid();`);
      actionMsg = `✅ ${tr("已断开", "Disconnected")} ${result.length} ${tr("个空闲连接", "idle connections")}`;
    } catch (err: unknown) {
      actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
    }
    setTimeout(() => actionMsg = null, 5000);
    await fetchDiagnostics();
  }

  async function terminateConnection(addr: string, port: string) {
    try {
      await runBouncerSql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE client_addr = '${addr}' AND client_port = ${port};`);
      actionMsg = `✅ ${tr("已断开来自", "Disconnected connection from")} ${addr}:${port}`;
      setTimeout(() => actionMsg = null, 4000);
      await fetchDiagnostics();
    } catch {}
  }

  onMount(() => fetchDiagnostics());

  const totalActive = $derived(pools.reduce((a, p) => a + parseInt(p.cl_active || "0"), 0));
  const totalWaiting = $derived(pools.reduce((a, p) => a + parseInt(p.cl_waiting || "0"), 0));
  const totalIdle = $derived(pools.reduce((a, p) => a + parseInt(p.sv_idle || "0"), 0));
  const totalUsed = $derived(pools.reduce((a, p) => a + parseInt(p.sv_used || "0"), 0));
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">{tr("连接池诊断", "Connection Pool Diagnostics")}</h2>
      <p class="text-xs text-muted-foreground mt-1">{tr("实时监控 PgBouncer / PostgreSQL 连接池状况，快速定位连接泄露", "Monitor PgBouncer / PostgreSQL pooling status in real time and quickly locate connection leaks")}</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={killIdleConnections} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border border-red-500/20 text-red-500 hover:bg-red-500/10 transition-colors">
        <Trash2 size={12} /> {tr("断开空闲连接", "Disconnect Idle")}
      </button>
      <button onclick={() => fetchDiagnostics()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <RefreshCw size={12} /> {tr("刷新", "Refresh")}
      </button>
    </div>
  </div>

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- Stats Overview -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="rounded-xl border bg-card p-4 text-center">
        <div class="flex items-center justify-center gap-2 text-green-600 mb-1"><Wifi size={14} /><span class="text-[10px] font-bold uppercase">{tr("活跃", "Active")}</span></div>
        <div class="text-2xl font-bold">{totalActive}</div>
      </div>
      <div class="rounded-xl border bg-card p-4 text-center">
        <div class="flex items-center justify-center gap-2 text-amber-600 mb-1"><Activity size={14} /><span class="text-[10px] font-bold uppercase">{tr("等待", "Waiting")}</span></div>
        <div class="text-2xl font-bold">{totalWaiting}</div>
      </div>
      <div class="rounded-xl border bg-card p-4 text-center">
        <div class="flex items-center justify-center gap-2 text-muted-foreground mb-1"><WifiOff size={14} /><span class="text-[10px] font-bold uppercase">{tr("空闲", "Idle")}</span></div>
        <div class="text-2xl font-bold">{totalIdle}</div>
      </div>
      <div class="rounded-xl border bg-card p-4 text-center">
        <div class="flex items-center justify-center gap-2 text-brand mb-1"><Activity size={14} /><span class="text-[10px] font-bold uppercase">{tr("总连接", "Total")}</span></div>
        <div class="text-2xl font-bold">{totalUsed}</div>
      </div>
    </div>

    <!-- Pools Table -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold">{tr("连接池分布", "Pool Distribution")}</h3>
      </div>
      {#if pools.length === 0}
        <div class="p-8 text-center text-muted-foreground text-xs">{tr("暂无活跃连接池数据", "No active pool data yet")}</div>
      {:else}
        <div class="overflow-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b">
              <tr>
                <th class="px-4 py-2.5 font-semibold text-muted-foreground">{tr("数据库", "Database")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("用户", "User")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{tr("活跃", "Active")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{tr("等待", "Waiting")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{tr("空闲", "Idle")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{tr("总数", "Total")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("模式", "Mode")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20">
              {#each pools as pool}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2.5 font-mono font-medium">{pool.database}</td>
                  <td class="px-3 py-2.5 font-mono text-muted-foreground">{pool.user}</td>
                  <td class="px-3 py-2.5 text-center font-bold text-green-600">{pool.cl_active}</td>
                  <td class="px-3 py-2.5 text-center font-bold {parseInt(pool.cl_waiting) > 0 ? 'text-amber-600' : 'text-muted-foreground'}">{pool.cl_waiting}</td>
                  <td class="px-3 py-2.5 text-center text-muted-foreground">{pool.sv_idle}</td>
                  <td class="px-3 py-2.5 text-center font-bold">{pool.sv_used}</td>
                  <td class="px-3 py-2.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-brand/10 text-brand">{pool.pool_mode}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <!-- Clients Table -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold">{tr("客户端连接明细（最近 50 条）", "Client Connection Details (Latest 50)")}</h3>
      </div>
      {#if clients.length === 0}
        <div class="p-8 text-center text-muted-foreground text-xs">{tr("没有活跃的客户端连接", "No active client connections")}</div>
      {:else}
        <div class="overflow-auto max-h-80">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b sticky top-0">
              <tr>
                <th class="px-4 py-2.5 font-semibold text-muted-foreground">{tr("用户", "User")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("数据库", "Database")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("状态", "Status")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("来源 IP", "Source IP")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("连接时间", "Connected At")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-right">{tr("操作", "Actions")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20">
              {#each clients as client}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2.5 font-mono">{client.user}</td>
                  <td class="px-3 py-2.5 font-mono text-muted-foreground">{client.database}</td>
                  <td class="px-3 py-2.5">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold {client.state === 'active' ? 'bg-green-500/10 text-green-600' : client.state === 'idle' ? 'bg-muted text-muted-foreground' : 'bg-amber-500/10 text-amber-600'}">{client.state}</span>
                  </td>
                  <td class="px-3 py-2.5 font-mono text-muted-foreground">{client.addr || '-'}:{client.port || '-'}</td>
                  <td class="px-3 py-2.5 text-muted-foreground text-[10px]">{client.connect_time}</td>
                  <td class="px-3 py-2.5 text-right">
                    {#if client.state === 'idle' && client.addr}
                      <button onclick={() => terminateConnection(client.addr, client.port)} class="px-2 py-1 text-[10px] rounded border border-red-500/20 text-red-500 hover:bg-red-500/10 transition-colors">
                        {tr("断开", "Disconnect")}
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>
