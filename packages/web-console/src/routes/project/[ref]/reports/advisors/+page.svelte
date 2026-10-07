<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { requestValidatedJson } from "$lib/validated-json";
  import { decodeAdvisorPayload, decodeConnectionRows, type AdvisorPayload, type ConnectionRow } from "$lib/project-advisors";
  import { Activity, Shield, Gauge, Cpu, AlertTriangle, BarChart3, RefreshCw } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  interface Advisor {
    title: string;
    description: string;
    icon: typeof Activity;
    status: "good" | "warning" | "critical" | "unknown";
    detail: string;
  }

  let payload = $state<AdvisorPayload | null>(null);
  let connections = $state<ConnectionRow[]>([]);
  let connectionsTruncated = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let refreshToken = $state(0);

  $effect(() => {
    const ref = projectRef;
    refreshToken;
    if (!ref) {
      payload = null;
      connections = [];
      connectionsTruncated = false;
      loading = false;
      return;
    }
    const controller = new AbortController();
    loading = true;
    error = null;
    payload = null;
    connections = [];
    connectionsTruncated = false;
    const request = <T>(url: string, decode: (value: unknown, responseStatus: number) => T) => requestValidatedJson(
      url,
      apiClient,
      decode,
      { signal: controller.signal },
      { statuses: [200], maxBytes: 512 * 1024 },
    );
    const settled = <T>(promise: Promise<T>) => promise.then(
      value => ({ ok: true as const, value }),
      cause => ({ ok: false as const, cause }),
    );
    void Promise.all([
      settled(requestValidatedJson(
        `/v1/projects/${encodeURIComponent(ref)}/advisors`,
        apiClient,
        (value) => decodeAdvisorPayload(value, ref),
        { signal: controller.signal },
        { statuses: [200], maxBytes: 512 * 1024 },
      )),
      settled(request(
        `/v1/projects/${encodeURIComponent(ref)}/advisors/connections`,
        (value) => decodeConnectionRows(value, ref),
      )),
    ]).then(([advisorResult, connectionResult]) => {
      if (controller.signal.aborted) return;
      const failures: string[] = [];
      if (advisorResult.ok) payload = advisorResult.value;
      else failures.push("顾问指标");
      if (connectionResult.ok) {
        connections = connectionResult.value.rows;
        connectionsTruncated = connectionResult.value.truncated;
      } else failures.push("连接观测");
      error = failures.length ? `${failures.join("、")}暂不可用` : null;
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        payload = null;
        connections = [];
        connectionsTruncated = false;
        error = cause instanceof Error ? cause.message : "顾问数据不可用";
      }
    }).finally(() => {
      if (!controller.signal.aborted) loading = false;
    });
    return () => controller.abort();
  });

  function rate(service: string): string {
    const item = payload?.error_rates.find((entry) => entry.service === service);
    if (!item || item.error_rate === null) return "未采集";
    return `${(item.error_rate * 100).toFixed(2)}% 错误率（${item.errors}/${item.observations}）`;
  }

  function rateStatus(service: string): Advisor["status"] {
    const status = payload?.error_rates.find((entry) => entry.service === service)?.status;
    return status === "ok" ? "good" : status === "warning" ? "warning" : "unknown";
  }

  function databaseStatus(): Advisor["status"] {
    if (!payload || !payload.database.available) return "unknown";
    return "good";
  }

  const performanceAdvisors = $derived<Advisor[]>([
    { title: "Data API 错误率", description: "最近 1 小时请求日志样本的 5xx 比例", icon: BarChart3, status: rateStatus("data_api"), detail: rate("data_api") },
    { title: "连接使用率", description: "项目客户端连接数 / 集群连接上限", icon: Activity, status: payload && payload.database.connections.max && payload.database.connections.active !== null && payload.database.connections.active / payload.database.connections.max > 0.8 ? "warning" : databaseStatus(), detail: payload && payload.database.connections.active !== null && payload.database.connections.max !== null ? `${payload.database.connections.active}/${payload.database.connections.max} 个连接` : "未采集" },
    { title: "锁等待", description: "当前被其他会话阻塞的连接", icon: AlertTriangle, status: !payload || payload.database.blocked_sessions === null ? "unknown" : payload.database.blocked_sessions ? "critical" : "good", detail: !payload || payload.database.blocked_sessions === null ? "未采集" : `${payload.database.blocked_sessions} 个阻塞会话` },
    { title: "未使用索引", description: "未发现访问记录且可能冗余的索引", icon: Gauge, status: !payload || payload.database.unused_indexes === null ? "unknown" : payload.database.unused_indexes ? "warning" : "good", detail: !payload || payload.database.unused_indexes === null ? "未采集" : `${payload.database.unused_indexes} 个候选索引` },
  ]);

  const securityAdvisors = $derived<Advisor[]>([
    { title: "RLS 启用状态", description: "检查 public 表是否启用 Row Level Security", icon: Shield, status: !payload?.database.available ? "unknown" : payload.database.tables_without_rls.length ? "warning" : "good", detail: payload?.database.available ? `${payload.database.tables_without_rls.length} 张表未启用 RLS` : "未采集" },
    { title: "Auth 错误率", description: "最近 1 小时请求日志样本的 5xx 比例", icon: Shield, status: rateStatus("auth"), detail: rate("auth") },
    { title: "Storage 错误率", description: "最近 1 小时请求日志样本的 5xx 比例", icon: Shield, status: rateStatus("storage"), detail: rate("storage") },
    { title: "Edge Functions 错误率", description: "最近 1 小时请求日志样本的 5xx 比例", icon: Cpu, status: rateStatus("edge_functions"), detail: rate("edge_functions") },
    { title: "Edge Functions 数量", description: "当前项目已部署函数数量", icon: Activity, status: !payload || !payload.edge_functions.available ? "unknown" : "good", detail: !payload || payload.edge_functions.count === null ? "未采集" : `${payload.edge_functions.count} 个函数` },
  ]);

  const blockedConnections = $derived(connections.filter((row) => row.blocking_pids.length > 0));

  function getStatusColor(status: string): string {
    if (status === "good") return "text-green-600 bg-green-500/10";
    if (status === "warning") return "text-amber-600 bg-amber-500/10";
    if (status === "unknown") return "text-slate-500 bg-slate-500/10";
    return "text-red-600 bg-red-500/10";
  }

  function getStatusLabel(status: string): string {
    if (status === "good") return "正常";
    if (status === "warning") return "需注意";
    if (status === "unknown") return "未知";
    return "严重";
  }
</script>

<div class="h-full flex flex-col space-y-6">
  <div>
    <h1 class="text-2xl font-bold">数据库顾问</h1>
    <p class="text-sm text-muted-foreground mt-1">性能、安全、连接与锁等待检查</p>
    <button
      onclick={() => refreshToken += 1}
      disabled={loading}
      class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
      title="刷新顾问数据"
    >
      <RefreshCw size={13} class={loading ? "animate-spin" : ""} />
      刷新
    </button>
  </div>

  {#if loading}
    <div class="rounded-lg border border-border/50 px-5 py-6 text-sm text-muted-foreground">正在读取项目顾问数据...</div>
  {:else if error}
    <div class="rounded-lg border border-red-500/30 bg-red-500/5 px-5 py-6 text-sm text-red-700">{error}</div>
  {/if}

  <!-- Performance -->
  <div class="space-y-3">
    <h2 class="text-lg font-semibold flex items-center gap-2"><Gauge size={18} /> 性能建议</h2>
    <div class="border-y border-border/50 overflow-hidden divide-y divide-border/20">
      {#each performanceAdvisors as advisor}
        <div class="flex flex-wrap items-center justify-between gap-3 px-3 sm:px-5 py-3.5 hover:bg-muted/10 transition-colors">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
              <advisor.icon size={14} />
            </div>
            <div>
              <span class="font-medium text-sm">{advisor.title}</span>
              <p class="text-[10px] text-muted-foreground">{advisor.description}</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-muted-foreground max-w-xs break-words">{advisor.detail}</span>
            <span class="px-2 py-0.5 rounded-full text-[9px] font-bold {getStatusColor(advisor.status)}">{getStatusLabel(advisor.status)}</span>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Security -->
  <div class="space-y-3">
    <h2 class="text-lg font-semibold flex items-center gap-2"><Shield size={18} /> 安全建议</h2>
    <div class="border-y border-border/50 overflow-hidden divide-y divide-border/20">
      {#each securityAdvisors as advisor}
        <div class="flex flex-wrap items-center justify-between gap-3 px-3 sm:px-5 py-3.5 hover:bg-muted/10 transition-colors">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
              <advisor.icon size={14} />
            </div>
            <div>
              <span class="font-medium text-sm">{advisor.title}</span>
              <p class="text-[10px] text-muted-foreground">{advisor.description}</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-muted-foreground max-w-xs break-words">{advisor.detail}</span>
            <span class="px-2 py-0.5 rounded-full text-[9px] font-bold {getStatusColor(advisor.status)}">{getStatusLabel(advisor.status)}</span>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold flex items-center gap-2"><AlertTriangle size={18} /> 连接与锁等待</h2>
      <span class="text-xs text-muted-foreground">{connections.length} 个会话{connectionsTruncated ? "，已截断" : ""}</span>
    </div>
    <div class="border-y border-border/50 overflow-auto max-h-[32rem]">
      {#if connections.length === 0}
        <div class="px-5 py-6 text-sm text-muted-foreground">暂无可用连接观测</div>
      {:else}
        <div class="divide-y divide-border/20">
          {#each connections as row}
            <div class="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-3 text-sm">
              <span class="font-mono text-xs text-muted-foreground">PID {row.pid}</span>
              <div class="min-w-0">
                <div class="truncate">{row.application || "未命名客户端"} · {row.role || "未知角色"}</div>
                <div class="text-xs text-muted-foreground">
                  {row.state || "未知状态"}{row.wait_event_type ? ` · ${row.wait_event_type}/${row.wait_event || "等待"}` : ""}
                </div>
              </div>
              <span class="text-xs {row.blocking_pids.length ? "text-red-600" : "text-muted-foreground"}">
                {row.blocking_pids.length ? `被 PID ${row.blocking_pids.join(", ")} 阻塞` : "未阻塞"}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    {#if blockedConnections.length > 0}
      <p class="text-xs text-red-600">当前有 {blockedConnections.length} 个会话正在等待其他会话释放资源。</p>
    {/if}
  </div>
</div>
