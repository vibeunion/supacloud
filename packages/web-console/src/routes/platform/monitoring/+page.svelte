<script lang="ts">
  import { onMount } from "svelte";
  import { BarChart3, ExternalLink, Maximize2, RefreshCw } from "lucide-svelte";
  import { locale } from "svelte-i18n";

  let grafanaHost = $state("");
  let selectedDashboard = $state("pgsql-overview");
  let isFullscreen = $state(false);
    
  const DASHBOARDS = [
    { id: "pgsql-overview", label: "PG Overview", descZh: "数据库集群全局指标概览", descEn: "Cluster-wide database metrics overview" },
    { id: "pgsql-instance", label: "PG Instance", descZh: "单实例详细指标", descEn: "Detailed metrics for a single instance" },
    { id: "pgsql-database", label: "PG Database", descZh: "数据库级别指标", descEn: "Database-level metrics" },
    { id: "pgsql-query", label: "PG Query", descZh: "查询性能分析", descEn: "Query performance analysis" },
    { id: "pgsql-table", label: "PG Table", descZh: "表级别 I/O 和大小", descEn: "Table-level I/O and size" },
    { id: "pgsql-activity", label: "PG Activity", descZh: "连接与锁活动", descEn: "Connection and lock activity" },
    { id: "pgsql-replication", label: "PG Replication", descZh: "流式复制状态", descEn: "Streaming replication status" },
    { id: "pgsql-persist", label: "PG Persist", descZh: "WAL 和检查点", descEn: "WAL and checkpoint metrics" },
    { id: "pgcat-overview", label: "Pgbouncer", descZh: "连接池监控", descEn: "Connection pool monitoring" },
    { id: "node", label: "Node", descZh: "操作系统 CPU/内存/磁盘/网络", descEn: "OS CPU/Memory/Disk/Network" },
  ];

  function detectGrafanaHost() {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    // In production, Grafana is reverse-proxied through /grafana/ path
    // In local dev, fall back to direct port 3000 access
    if (host === "localhost" || host === "127.0.0.1") {
      grafanaHost = `${protocol}//${host}:3000/grafana`;
    } else {
      grafanaHost = `${protocol}//${host}/grafana`;
    }
  }

  const grafanaUrl = $derived(
    `${grafanaHost}/d/${selectedDashboard}?orgId=1&kiosk=tv&theme=dark`
  );

  onMount(() => detectGrafanaHost());
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">{$t("PlatformMonitoring.grafana_monitoring_dashboard")}</h2>
      <p class="text-xs text-muted-foreground mt-1">{$t("PlatformMonitoring.embedded_pigsty_prometheus_grafana_dashboards")}</p>
    </div>
    <div class="flex items-center gap-2">
      <a href={grafanaHost} target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <ExternalLink size={12} /> {$t("PlatformMonitoring.open_in_new_window")}
      </a>
      <button onclick={() => isFullscreen = !isFullscreen} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <Maximize2 size={12} /> {isFullscreen ? $t("PlatformMonitoring.exit_fullscreen") : $t("PlatformMonitoring.fullscreen")}
      </button>
    </div>
  </div>

  <!-- Grafana Host Input -->
  <div class="flex items-center gap-3">
    <label for="a11y-routes-platform-monitoring--page-svelte-53" class="text-xs font-semibold text-muted-foreground shrink-0">{$t("PlatformMonitoring.grafana_url")}</label>
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
        <span class="text-[9px] opacity-70">{tr(db.descZh, db.descEn)}</span>
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
        <p class="text-sm">{$t("PlatformMonitoring.please_enter_the_grafana_server")}</p>
        <p class="text-xs opacity-60">{$t("PlatformMonitoring.pigsty_is_typically_deployed_on")}</p>
      </div>
    {/if}
  </div>
</div>
