<script lang="ts">
  import { apiClient } from "$lib/api";
  import {
    createProjectLoadToken,
    isCurrentProjectLoad,
    type ProjectLoadToken,
  } from "$lib/project-load-guard";

  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import {
    Loader2, Database, Users, HardDrive, Zap, Activity, Server,
    ArrowRight, BarChart3, Shield, Code2, Radio, ScrollText, Folder,
    RefreshCw, CheckCircle2, XCircle, MinusCircle, Clock, FileText, Terminal
  } from "lucide-svelte";

  interface ServiceInfo {
    name: string;
    status: string;
  }

  type TaskStats = {
    running: number;
    retryScheduled: number;
    deadLettered: number;
    failedLast24h: number;
    cancelledLast24h: number;
    topFailures: Array<{ message: string; count: number }>;
    failedTrend: Array<{ bucket: string; failures: number }>;
  };

  let isLoading = $state(true);
  let dbSize = $state("-");
  let connections = $state(0);
  let maxConnections = $state(100);
  let totalUsers = $state(0);
  let authManagedByRef = $state<string | null>(null);
  let functionsCount = $state(0);
  let storageSize = $state("-");
  let cacheHitRatio = $state(0);
  let tableCount = $state(0);
  let indexCount = $state(0);
  let recentUsers = $state<Record<string, unknown>[]>([]);
  let activeQueries = $state<Record<string, unknown>[]>([]);
  let services = $state<ServiceInfo[]>([]);
  let servicesLoading = $state(true);
  let taskStats = $state<TaskStats | null>(null);
  let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let loadRevision = 0;
  let loadedProjectRef = "";

  const projectRef = $derived(page.params.ref ?? "");

  type DashboardSummary = {
    database?: {
      size?: string;
      cache_hit_ratio?: number;
      connections?: number;
      max_connections?: number;
      table_count?: number;
      index_count?: number;
    };
    auth?: {
      total_users?: number | null;
      recent_users?: Record<string, unknown>[];
      source?: "local" | "supauth";
      managed_by_ref?: string | null;
    };
    storage?: {
      size?: string;
    };
    functions?: {
      count?: number;
    };
    tasks?: TaskStats | null;
    active_queries?: Record<string, unknown>[];
  };

  function isCurrentLoad(loadToken: ProjectLoadToken): boolean {
    return isCurrentProjectLoad(loadToken, projectRef, loadRevision);
  }

  async function runSql(ref: string, sql: string): Promise<Record<string, unknown>[]> {
    try {
      const res = await apiClient(`/v1/projects/${ref}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql })
      });
      const data = await res.json();
      if (data.error) return [];
      return data.rows || [];
    } catch { return []; }
  }

  function applyDashboardSummary(summary: DashboardSummary) {
    const database = summary.database || {};
    const auth = summary.auth || {};
    const storage = summary.storage || {};
    const functions = summary.functions || {};

    dbSize = String(database.size || "-");
    cacheHitRatio = Number(database.cache_hit_ratio || 0);
    connections = Number(database.connections || 0);
    maxConnections = Number(database.max_connections || 100);
    authManagedByRef = auth.source === "supauth" ? auth.managed_by_ref || null : null;
    totalUsers = authManagedByRef ? 0 : Number(auth.total_users || 0);
    tableCount = Number(database.table_count || 0);
    indexCount = Number(database.index_count || 0);
    storageSize = String(storage.size || "0 bytes");
    functionsCount = Number(functions.count || 0);
    recentUsers = authManagedByRef ? [] : auth.recent_users || [];
    activeQueries = summary.active_queries || [];
    taskStats = summary.tasks || null;
  }

  async function fetchFunctionsCountLegacy(ref: string): Promise<number> {
    try {
      const res = await apiClient(`/v1/projects/${ref}/functions`);
      if (!res.ok) return 0;
      const data = await res.json();
      return Array.isArray(data) ? data.length : 0;
    } catch {
      return 0;
    }
  }

  async function refreshAuthRuntimeOwner(ref: string, loadToken: ProjectLoadToken): Promise<boolean> {
    try {
      const response = await apiClient(`/v1/projects/${ref}/auth/runtime`);
      if (!response.ok || !isCurrentLoad(loadToken)) return false;
      const runtime = await response.json() as {
        mode?: "local" | "owner" | "shared";
        authority_project_ref?: string;
      };
      if (!isCurrentLoad(loadToken)) return false;
      authManagedByRef = runtime.mode === "shared" && runtime.authority_project_ref
        ? runtime.authority_project_ref
        : null;
      return true;
    } catch {
      return false;
    }
  }

  async function fetchDashboardLegacy(
    ref: string,
    loadToken: ProjectLoadToken,
    authRuntimeKnown: boolean,
  ): Promise<void> {
    const canReadLocalAuth = authRuntimeKnown && !authManagedByRef;
    const [dbInfo, connInfo, userInfo, tableInfo, indexInfo, storageInfo, recentUserInfo, activeInfo] = await Promise.all([
      runSql(ref, `SELECT pg_size_pretty(pg_database_size(current_database())) as size,
              (SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 1) FROM pg_stat_database WHERE datname = current_database()) as cache_ratio;`),
      runSql(ref, `SELECT count(*) as active FROM pg_stat_activity WHERE backend_type = 'client backend';`),
      canReadLocalAuth ? runSql(ref, `SELECT count(*) as total FROM auth.users;`) : Promise.resolve([]),
      runSql(ref, `SELECT count(*) as cnt FROM pg_stat_user_tables;`),
      runSql(ref, `SELECT count(*) as cnt FROM pg_stat_user_indexes;`),
      runSql(ref, `SELECT pg_size_pretty(coalesce(sum(CASE WHEN metadata->>'size' ~ '^[0-9]+$' THEN (metadata->>'size')::bigint ELSE 0 END), 0)) as size FROM storage.objects;`),
      canReadLocalAuth
        ? runSql(ref, `SELECT email, created_at::text FROM auth.users ORDER BY created_at DESC LIMIT 5;`)
        : Promise.resolve([]),
      runSql(ref, `SELECT pid, usename, state, left(query, 80) as query FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active' LIMIT 5;`),
    ]);
    if (!isCurrentLoad(loadToken)) return;

    if (dbInfo[0]) {
      dbSize = String(dbInfo[0].size || "-");
      cacheHitRatio = parseFloat(String(dbInfo[0].cache_ratio || "0"));
    }
    if (connInfo[0]) connections = parseInt(String(connInfo[0].active || "0"));
    if (!authManagedByRef && userInfo[0]) totalUsers = parseInt(String(userInfo[0].total || "0"));
    if (tableInfo[0]) tableCount = parseInt(String(tableInfo[0].cnt || "0"));
    if (indexInfo[0]) indexCount = parseInt(String(indexInfo[0].cnt || "0"));
    if (storageInfo[0]) storageSize = String(storageInfo[0].size || "0 bytes");
    recentUsers = authManagedByRef ? [] : recentUserInfo;
    activeQueries = activeInfo;

    const nextFunctionsCount = await fetchFunctionsCountLegacy(ref);
    if (!isCurrentLoad(loadToken)) return;
    functionsCount = nextFunctionsCount;
    await fetchTaskStats(ref, loadToken);
  }

  async function fetchDashboard(ref: string, loadToken: ProjectLoadToken): Promise<void> {
    try {
      const res = await apiClient(`/v1/projects/${ref}/dashboard/summary`);
      if (!res.ok) throw new Error("summary unavailable");
      const summary = await res.json() as DashboardSummary;
      if (isCurrentLoad(loadToken)) applyDashboardSummary(summary);
    } catch {
      const authRuntimeKnown = await refreshAuthRuntimeOwner(ref, loadToken);
      if (!isCurrentLoad(loadToken)) return;
      await fetchDashboardLegacy(ref, loadToken, authRuntimeKnown);
    } finally {
      if (isCurrentLoad(loadToken)) isLoading = false;
    }
  }

  async function fetchServices(ref: string, loadToken: ProjectLoadToken): Promise<void> {
    try {
      const res = await apiClient(`/v1/projects/${ref}/services`);
      if (res.ok) {
        const data = await res.json();
        if (isCurrentLoad(loadToken)) {
          services = Array.isArray(data) ? data : (data.services || []);
        }
      }
    } catch {
      // 服务状态是次要信息；请求失败时保留最近一次可用状态。
    }
    if (isCurrentLoad(loadToken)) servicesLoading = false;
  }

  async function fetchTaskStatsValue(ref: string): Promise<TaskStats | null> {
    try {
      const res = await apiClient(`/v1/projects/${ref}/tasks/stats`);
      return res.ok ? await res.json() as TaskStats : null;
    } catch {
      return null;
    }
  }

  async function fetchTaskStats(ref: string, loadToken: ProjectLoadToken): Promise<void> {
    const nextTaskStats = await fetchTaskStatsValue(ref);
    if (nextTaskStats && isCurrentLoad(loadToken)) taskStats = nextTaskStats;
  }

  function resetProjectDashboardState(): void {
    dbSize = "-";
    connections = 0;
    maxConnections = 100;
    totalUsers = 0;
    cacheHitRatio = 0;
    storageSize = "0 bytes";
    functionsCount = 0;
    tableCount = 0;
    indexCount = 0;
    recentUsers = [];
    activeQueries = [];
    services = [];
    taskStats = null;
    authManagedByRef = null;
  }

  function loadProject(ref: string): void {
    if (ref !== loadedProjectRef) {
      loadedProjectRef = ref;
      resetProjectDashboardState();
    }
    loadRevision += 1;
    const loadToken = createProjectLoadToken(ref, loadRevision);
    isLoading = true;
    servicesLoading = true;
    void fetchDashboard(ref, loadToken);
    void fetchServices(ref, loadToken);
  }

  $effect(() => {
    const ref = projectRef;
    if (ref) loadProject(ref);
  });

  onMount(() => {
    autoRefreshTimer = setInterval(() => {
      if (projectRef) {
        const loadToken = createProjectLoadToken(projectRef, loadRevision);
        void fetchTaskStats(projectRef, loadToken);
      }
    }, 30000);

    return () => {
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    };
  });

  const QUICK_LINKS = $derived(projectRef ? ([
    { name: $t("Navigation.sql_editor"), route: "/project/[ref]/sql", icon: Terminal, color: "text-blue-600 bg-blue-500/10 border-blue-500/20" },
    { name: $t("Navigation.table_editor"), route: "/project/[ref]/tables", icon: Database, color: "text-violet-600 bg-violet-500/10 border-violet-500/20" },
    { name: $t("Navigation.auth"), route: "/project/[ref]/auth", icon: Users, color: "text-emerald-600 bg-emerald-500/10 border-emerald-500/20" },
    { name: $t("Navigation.storage"), route: "/project/[ref]/storage", icon: Folder, color: "text-teal-600 bg-teal-500/10 border-teal-500/20" },
    { name: $t("Navigation.edge_functions"), route: "/project/[ref]/functions", icon: Zap, color: "text-amber-600 bg-amber-500/10 border-amber-500/20" },
    { name: $t("Navigation.logs"), route: "/project/[ref]/logs", icon: ScrollText, color: "text-pink-600 bg-pink-500/10 border-pink-500/20" },
    { name: $t("Navigation.settings"), route: "/project/[ref]/settings", icon: Server, color: "text-slate-600 bg-slate-500/10 border-slate-500/20" },
  ] as const) : []);

  function getStatusColor(status: string): string {
    if (status === "RUNNING" || status === "running" || status === "active" || status === "ACTIVE_HEALTHY") return "text-green-600";
    if (status === "INACTIVE" || status === "inactive" || status === "dead") return "text-muted-foreground/50";
    return "text-amber-600";
  }

  function getStatusIcon(status: string) {
    if (status === "RUNNING" || status === "running" || status === "active" || status === "ACTIVE_HEALTHY") return CheckCircle2;
    if (status === "INACTIVE" || status === "inactive" || status === "dead") return MinusCircle;
    return XCircle;
  }

  function sparklinePath(values: number[]) {
    if (values.length === 0) return "";
    const width = 220;
    const height = 48;
    const max = Math.max(...values, 1);
    return values
      .map((value, index) => {
        const x = (index / Math.max(values.length - 1, 1)) * width;
        const y = height - (value / max) * height;
        return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("Dashboard.project_dashboard")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Dashboard.subtitle") || '项目概览和快速访问导航'}</p>
    </div>
    <button onclick={() => loadProject(projectRef)}
      class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
      <RefreshCw size={12} />
      {$t("Logs.refresh") || '刷新'}
    </button>
  </div>

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- Stats Cards -->
    <div class="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-center gap-2 text-muted-foreground">
          <Database size={14} />
          <span class="text-[10px] font-semibold uppercase">{$t("Settings.db_size")}</span>
        </div>
        <div class="mt-2 text-2xl font-bold text-brand">{dbSize}</div>
        <div class="mt-1 text-[10px] text-muted-foreground">{tableCount} {$t("Tables.table_count")} · {indexCount} {$t("Indexes.title", {default: "个索引"})}</div>
      </div>

      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-center gap-2 text-muted-foreground">
          <Activity size={14} />
          <span class="text-[10px] font-semibold uppercase">{$t("Dashboard.db_connections")}</span>
        </div>
        <div class="mt-2 text-2xl font-bold">{connections}</div>
        <div class="mt-1 text-[10px] text-muted-foreground">
          {$t("Dashboard.cache_hit_ratio", {default: "缓存命中率"})}
          <span class="{cacheHitRatio > 95 ? 'text-green-600' : cacheHitRatio > 80 ? 'text-amber-600' : 'text-red-600'} font-semibold ml-1">
            {cacheHitRatio}%
          </span>
        </div>
      </div>

      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-center gap-2 text-muted-foreground">
          <Users size={14} />
          <span class="text-[10px] font-semibold uppercase">{$t("Dashboard.auth_users")}</span>
        </div>
        {#if authManagedByRef}
          <div class="mt-2 text-lg font-bold">SupAuth</div>
          <div class="mt-1 text-[10px] text-muted-foreground">
            用户由
            <a class="font-mono text-brand hover:underline" href={resolve("/project/[ref]/auth", { ref: authManagedByRef })}>
              {authManagedByRef}
            </a>
            统一管理
          </div>
        {:else}
          <div class="mt-2 text-2xl font-bold">{totalUsers.toLocaleString()}</div>
          <div class="mt-1 text-[10px] text-muted-foreground">{$t("Auth.users_count")}</div>
        {/if}
      </div>

      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-center gap-2 text-muted-foreground">
          <Zap size={14} />
          <span class="text-[10px] font-semibold uppercase">{$t("Navigation.edge_functions")}</span>
        </div>
        <div class="mt-2 text-2xl font-bold">{functionsCount}</div>
        <div class="mt-1 text-[10px] text-muted-foreground">{$t("Functions.no_functions", {default: "已部署函数"}).replace('暂无', '')}</div>
      </div>

      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-center gap-2 text-muted-foreground">
          <HardDrive size={14} />
          <span class="text-[10px] font-semibold uppercase">{$t("Dashboard.storage_used")}</span>
        </div>
        <div class="mt-2 text-2xl font-bold">{storageSize}</div>
        <div class="mt-1 text-[10px] text-muted-foreground">Storage {$t("Storage.size", {default: "文件总量"})}</div>
      </div>
    </div>

    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
        <div>
          <h2 class="text-sm font-semibold flex items-center gap-2"><Activity size={14} /> {$t("DashboardTasks.title")}</h2>
          <p class="text-[11px] text-muted-foreground mt-1">{$t("DashboardTasks.subtitle")}</p>
        </div>
        <a href={resolve("/project/[ref]/tasks", { ref: projectRef })} class="text-[10px] text-brand hover:underline flex items-center gap-1">{$t("DashboardTasks.open_panel")} <ArrowRight size={10} /></a>
      </div>

      <div class="p-5 space-y-5">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div class="rounded-xl border bg-background p-4">
            <div class="text-[10px] uppercase text-muted-foreground font-semibold">{$t("DashboardTasks.running")}</div>
            <div class="mt-2 text-2xl font-bold text-blue-600">{taskStats?.running ?? 0}</div>
          </div>
          <div class="rounded-xl border bg-background p-4">
            <div class="text-[10px] uppercase text-muted-foreground font-semibold">{$t("DashboardTasks.retrying")}</div>
            <div class="mt-2 text-2xl font-bold text-amber-600">{taskStats?.retryScheduled ?? 0}</div>
          </div>
          <div class="rounded-xl border bg-background p-4">
            <div class="text-[10px] uppercase text-muted-foreground font-semibold">{$t("DashboardTasks.dead_letter")}</div>
            <div class="mt-2 text-2xl font-bold text-red-600">{taskStats?.deadLettered ?? 0}</div>
          </div>
          <div class="rounded-xl border bg-background p-4">
            <div class="text-[10px] uppercase text-muted-foreground font-semibold">{$t("DashboardTasks.failures_24h")}</div>
            <div class="mt-2 text-2xl font-bold text-foreground">{taskStats?.failedLast24h ?? 0}</div>
          </div>
          <div class="rounded-xl border bg-background p-4">
            <div class="text-[10px] uppercase text-muted-foreground font-semibold">{$t("DashboardTasks.cancelled_24h")}</div>
            <div class="mt-2 text-2xl font-bold text-slate-700">{taskStats?.cancelledLast24h ?? 0}</div>
          </div>
        </div>

        <div class="rounded-xl border bg-background p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold text-foreground">{$t("DashboardTasks.failure_trend")}</h3>
            <span class="text-[11px] text-muted-foreground">{$t("DashboardTasks.hourly_aggregation")}</span>
          </div>

          {#if !taskStats || taskStats.failedTrend.length === 0}
            <div class="text-sm text-muted-foreground py-6 text-center">
              {$t("DashboardTasks.no_failures")}
            </div>
          {:else}
            <div class="space-y-4">
              <svg viewBox="0 0 220 48" class="w-full h-14 rounded bg-red-50/50 border border-red-500/10">
                <path
                  d={sparklinePath(taskStats.failedTrend.map((point) => point.failures))}
                  fill="none"
                  stroke="currentColor"
                  class="text-red-500"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>

              <div class="space-y-2">
                {#each taskStats.failedTrend as point (point.bucket)}
                  <div class="grid grid-cols-[88px_1fr_32px] items-center gap-3">
                    <div class="text-[11px] font-mono text-muted-foreground">{point.bucket}</div>
                    <div class="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        class="h-full bg-red-500 rounded-full"
                        style={`width: ${Math.max(8, (point.failures / Math.max(...taskStats.failedTrend.map((p) => p.failures), 1)) * 100)}%`}
                      ></div>
                    </div>
                    <div class="text-[11px] font-mono text-foreground text-right">{point.failures}</div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        <div class="rounded-xl border bg-background p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold text-foreground">{$t("DashboardTasks.top_failures")}</h3>
            <span class="text-[11px] text-muted-foreground">{$t("DashboardTasks.top_5_24h")}</span>
          </div>
          {#if !taskStats || taskStats.topFailures.length === 0}
            <div class="text-sm text-muted-foreground py-6 text-center">
              {$t("DashboardTasks.no_anomalies")}
            </div>
          {:else}
            <div class="space-y-2">
              {#each taskStats.topFailures as item (`${item.message}:${item.count}`)}
                <div class="rounded-lg border border-border/60 px-3 py-2">
                  <div class="text-xs text-foreground break-all">{item.message}</div>
                  <div class="mt-1 text-[11px] text-muted-foreground font-mono">{$t("DashboardTasks.occurrences", { default: `出现 ${item.count} 次` })}</div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-3">
      <!-- Left: Services Status -->
      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
          <h2 class="text-sm font-semibold flex items-center gap-2"><Server size={14} /> {$t("DashboardServices.title")} </h2>
          <a href={resolve("/project/[ref]/settings/services", { ref: projectRef })} class="text-[10px] text-brand hover:underline flex items-center gap-1">{$t("DashboardServices.manage")} <ArrowRight size={10} /></a>
        </div>
        <div class="divide-y divide-border/20">
          {#if servicesLoading}
            <div class="flex items-center justify-center py-8">
              <Loader2 size={16} class="animate-spin text-brand opacity-50" />
            </div>
          {:else if services.length === 0}
            <div class="p-4 text-xs text-muted-foreground text-center">{$t("DashboardServices.unavailable")}</div>
          {:else}
            {#each services as svc (svc.name)}
              {@const StatusIcon = getStatusIcon(svc.status)}
              <div class="flex items-center justify-between px-5 py-2.5">
                <div class="flex items-center gap-2">
                  <StatusIcon size={12} class={getStatusColor(svc.status)} />
                  <span class="text-xs font-medium">{svc.name}</span>
                </div>
                <span class="text-[10px] font-mono {getStatusColor(svc.status)}">{svc.status}</span>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Middle: Recent Users -->
      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
          <h2 class="text-sm font-semibold flex items-center gap-2"><Users size={14} /> {$t("DashboardRecentUsers.title")} </h2>
          <a href={resolve("/project/[ref]/auth", { ref: authManagedByRef || projectRef })} class="text-[10px] text-brand hover:underline flex items-center gap-1">{$t("DashboardRecentUsers.view_all")} <ArrowRight size={10} /></a>
        </div>
        {#if authManagedByRef}
          <div class="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
            <Shield size={24} strokeWidth={1} />
            <p class="text-xs">共享用户目录仅在 SupAuth 权威项目中展示</p>
          </div>
        {:else if recentUsers.length === 0}
          <div class="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2 opacity-40">
            <Users size={24} strokeWidth={1} />
            <p class="text-xs">{$t("DashboardRecentUsers.no_users")}</p>
          </div>
        {:else}
          <div class="divide-y divide-border/20">
            {#each recentUsers as user (`${String(user.email)}:${String(user.created_at)}`)}
              <div class="px-5 py-2.5 flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <div class="w-6 h-6 rounded-full bg-brand/10 text-brand flex items-center justify-center text-[10px] font-bold">
                    {String(user.email || "?").charAt(0).toUpperCase()}
                  </div>
                  <span class="text-xs font-mono truncate max-w-[160px]">{user.email || "-"}</span>
                </div>
                <span class="text-[10px] text-muted-foreground">{String(user.created_at || "").substring(0, 10)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Right: Active Queries -->
      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
          <h2 class="text-sm font-semibold flex items-center gap-2"><Code2 size={14} /> {$t("DashboardActiveQueries.title")} </h2>
          <a href={resolve("/project/[ref]/reports/api-overview", { ref: projectRef })} class="text-[10px] text-brand hover:underline flex items-center gap-1">{$t("DashboardActiveQueries.details")} <ArrowRight size={10} /></a>
        </div>
        {#if activeQueries.length === 0}
          <div class="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2 opacity-40">
            <Activity size={24} strokeWidth={1} />
            <p class="text-xs">{$t("DashboardActiveQueries.no_queries")}</p>
          </div>
        {:else}
          <div class="divide-y divide-border/20">
            {#each activeQueries as q (String(q.pid))}
              <div class="px-5 py-2.5">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[10px] font-mono text-muted-foreground">PID {q.pid}</span>
                  <span class="text-[10px] font-mono text-brand">{q.usename}</span>
                </div>
                <p class="text-[10px] font-mono text-muted-foreground truncate">{q.query}</p>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <!-- Quick Links -->
    <div>
      <h2 class="text-sm font-semibold mb-3 flex items-center gap-2"><ArrowRight size={14} /> {$t("DashboardQuickAccess.title")} </h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        {#each QUICK_LINKS as link (link.route)}
          <a href={resolve(link.route, { ref: projectRef })}
            class="flex items-center gap-3 rounded-xl border bg-card p-4 hover:border-brand/40 hover:shadow-md transition-all group">
            <div class="w-9 h-9 rounded-lg {link.color} flex items-center justify-center group-hover:scale-110 transition-transform">
              <link.icon size={18} />
            </div>
            <span class="text-xs font-semibold">{link.name}</span>
          </a>
        {/each}
      </div>
    </div>
  {/if}
</div>
