<script lang="ts">
  import { onMount } from "svelte";
  import { BarChart3, ExternalLink, Maximize2, RefreshCw } from "lucide-svelte";

  let grafanaHost = $state("");
  let selectedDashboard = $state("pgsql-overview");
  let isFullscreen = $state(false);

  const DASHBOARDS = [
    { id: "pgsql-overview", label: "PG 总览", desc: "数据库集群全局指标概览" },
    { id: "pgsql-instance", label: "PG 实例", desc: "单实例详细指标" },
    { id: "pgsql-database", label: "PG 数据库", desc: "数据库级别指标" },
    { id: "pgsql-query", label: "PG 查询", desc: "查询性能分析" },
    { id: "pgsql-table", label: "PG 表", desc: "表级别 I/O 和大小" },
    { id: "pgsql-activity", label: "PG 活动", desc: "连接与锁活动" },
    { id: "pgsql-replication", label: "PG 复制", desc: "流式复制状态" },
    { id: "pgsql-persist", label: "PG 持久化", desc: "WAL 和检查点" },
    { id: "pgcat-overview", label: "Pgbouncer", desc: "连接池监控" },
    { id: "node", label: "节点", desc: "操作系统 CPU/内存/磁盘/网络" },
  ];

  function detectGrafanaHost() {
    // Try to detect: same host, port 3000
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    grafanaHost = `${protocol}//${host}:3000`;
  }

  const grafanaUrl = $derived(
    `${grafanaHost}/d/${selectedDashboard}?orgId=1&kiosk=tv&theme=dark`
  );

  onMount(() => detectGrafanaHost());
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">Grafana 监控大屏</h2>
      <p class="text-xs text-muted-foreground mt-1">嵌入 Pigsty 的 Prometheus + Grafana 监控面板，实时观测数据库与系统指标</p>
    </div>
    <div class="flex items-center gap-2">
      <a href={grafanaHost} target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <ExternalLink size={12} /> 新窗口打开
      </a>
      <button onclick={() => isFullscreen = !isFullscreen} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <Maximize2 size={12} /> {isFullscreen ? '退出全屏' : '全屏'}
      </button>
    </div>
  </div>

  <!-- Grafana Host Input -->
  <div class="flex items-center gap-3">
    <label for="a11y-routes-platform-monitoring--page-svelte-53" class="text-xs font-semibold text-muted-foreground shrink-0">Grafana 地址:</label>
    <input id="a11y-routes-platform-monitoring--page-svelte-53" bind:value={grafanaHost} class="flex-1 max-w-md px-3 py-1.5 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" placeholder="http://your-server:3000" />
  </div>

  <!-- Dashboard Selector -->
  <div class="flex items-center gap-2 overflow-x-auto pb-2">
    {#each DASHBOARDS as db}
      <button
        onclick={() => selectedDashboard = db.id}
        class="flex flex-col items-start px-3 py-2 text-[10px] rounded-lg border whitespace-nowrap transition-all {selectedDashboard === db.id ? 'border-brand bg-brand/5 text-brand' : 'bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground'}"
      >
        <span class="font-bold">{db.label}</span>
        <span class="text-[9px] opacity-70">{db.desc}</span>
      </button>
    {/each}
  </div>

  <!-- Grafana iframe -->
  <div class="rounded-xl border bg-card overflow-hidden {isFullscreen ? 'fixed inset-0 z-50' : ''}">
    {#if grafanaHost}
      <iframe
        src={grafanaUrl}
        title="Grafana Dashboard"
        class="w-full border-0 {isFullscreen ? 'h-full' : 'h-[70vh]'}"
        allow="fullscreen"
      ></iframe>
    {:else}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <BarChart3 size={40} class="opacity-30" />
        <p class="text-sm">请在上方输入 Grafana 服务器地址以加载监控面板</p>
        <p class="text-xs opacity-60">Pigsty 默认部署在同一台服务器的 3000 端口</p>
      </div>
    {/if}
  </div>
</div>
