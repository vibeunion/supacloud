<script lang="ts">
  import { onMount } from "svelte";
  import { BarChart3, ExternalLink, Maximize2, RefreshCw } from "lucide-svelte";
  import { t } from "svelte-i18n";
  import { toast } from "svelte-sonner";

  let grafanaHost = $state("");
  let grafanaAvailable = $state(false);
  let grafanaChecking = $state(false);
  let grafanaCheckError = $state<string | null>(null);
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

  async function checkGrafanaHealth(url: string) {
    const trimmed = url.trim().replace(/\/+$/, "");
    grafanaCheckError = null;
    if (!trimmed) {
      grafanaAvailable = false;
      grafanaCheckError = "请输入 Grafana 地址";
      return;
    }

    grafanaChecking = true;
    try {
      const healthUrl = new URL(`${trimmed}/api/health`);
      const isSameOrigin = healthUrl.origin === window.location.origin;
      if (!isSameOrigin) {
        grafanaAvailable = true;
        return;
      }

      const res = await fetch(healthUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      const contentType = res.headers.get("content-type") || "";
      grafanaAvailable = res.ok && contentType.includes("application/json");
      if (!grafanaAvailable) {
        grafanaCheckError = res.ok
          ? "Grafana 健康接口未返回 JSON"
          : `Grafana 健康接口返回 HTTP ${res.status}`;
      }
    } catch {
      grafanaAvailable = false;
      grafanaCheckError = "无法连接 Grafana 服务，请检查地址和网络状态";
    } finally {
      grafanaChecking = false;
    }
  }

  async function runGrafanaHealthCheck() {
    await checkGrafanaHealth(grafanaHost);
    if (grafanaAvailable) {
      toast.success("Grafana 检测成功");
      return;
    }
    toast.error(grafanaCheckError || "Grafana 检测失败");
  }

  function resetGrafanaHealth() {
    grafanaAvailable = false;
    grafanaCheckError = null;
  }

  async function detectGrafanaHost() {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    // In production, Grafana is reverse-proxied through /grafana/ path
    // In local dev, fall back to direct port 3000 access
    if (host === "localhost" || host === "127.0.0.1") {
      grafanaHost = `${protocol}//${host}:3000/grafana`;
    } else {
      grafanaHost = `${protocol}//${host}/grafana`;
    }
    await checkGrafanaHealth(grafanaHost);
  }

  const grafanaUrl = $derived(
    `${grafanaHost}/d/${selectedDashboard}?orgId=1&kiosk=tv&theme=dark`
  );

  onMount(() => {
    void detectGrafanaHost();
  });
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
  <div class="space-y-1">
    <div class="flex items-center gap-3">
      <label for="a11y-routes-platform-monitoring--page-svelte-53" class="text-xs font-semibold text-muted-foreground shrink-0">{$t("PlatformMonitoring.grafana_url")}</label>
      <input id="a11y-routes-platform-monitoring--page-svelte-53" bind:value={grafanaHost} oninput={resetGrafanaHealth} class="flex-1 max-w-md px-3 py-1.5 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" placeholder="http://your-server:3000" />
      <button onclick={runGrafanaHealthCheck} disabled={grafanaChecking} aria-busy={grafanaChecking} class="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border hover:bg-muted/50 transition-colors disabled:opacity-50">
        <RefreshCw size={12} class={grafanaChecking ? "animate-spin" : ""} /> {grafanaChecking ? "检测中..." : "检测"}
      </button>
    </div>
    {#if grafanaCheckError}
      <p class="text-xs text-destructive">{grafanaCheckError}</p>
    {/if}
  </div>

  <!-- Dashboard Selector -->
  <div class="flex items-center gap-2 overflow-x-auto pb-2">
    {#each DASHBOARDS as db}
      <button
        onclick={() => selectedDashboard = db.id}
        class="flex flex-col items-start px-3 py-2 text-[10px] rounded-lg border whitespace-nowrap transition-all {selectedDashboard === db.id ? 'border-brand bg-brand/5 text-brand' : 'bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground'}"
      >
        <span class="font-bold">{db.label}</span>
        <span class="text-[9px] opacity-70">{$t("PlatformMonitoring.dashboard_" + db.id)}</span>
      </button>
    {/each}
  </div>

  <!-- Grafana iframe -->
  <div class="rounded-xl border bg-card overflow-hidden {isFullscreen ? 'fixed inset-0 z-50' : ''}">
    {#if grafanaHost && grafanaAvailable}
      <iframe
        src={grafanaUrl}
        title="Grafana Dashboard"
        class="w-full border-0 {isFullscreen ? 'h-full' : 'h-[70vh]'}"
        allow="fullscreen"
      ></iframe>
    {:else}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <BarChart3 size={40} class="opacity-30" />
        <p class="text-sm">
          {grafanaChecking ? "正在检测 Grafana..." : $t("PlatformMonitoring.please_enter_the_grafana_server")}
        </p>
        <p class="text-xs opacity-60">当前地址未返回 Grafana 健康接口，已避免加载无效 iframe。</p>
      </div>
    {/if}
  </div>
</div>
