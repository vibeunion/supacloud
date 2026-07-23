<script lang="ts">
  import { apiClient } from "$lib/api";
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import {
    Loader2, FolderKanban, Users, Cpu, HardDrive,
    ArrowRight, ArrowUpRight, Plus, Activity, Clock,
    Server, RefreshCw, CheckCircle2, XCircle, PauseCircle
  } from "lucide-svelte";

  interface ProjectItem {
    ref: string;
    name: string;
    status: string;
    region: string;
    db_name: string;
    created_at: string;
  }

  let projects = $state<ProjectItem[]>([]);
  let loading = $state(true);
  let systemInfo = $state<{ cpu?: string; memory?: string; uptime?: string; version?: string }>({});

  onMount(async () => {
    try {
      const [projRes, sysRes] = await Promise.all([
        apiClient("/v1/projects"),
        apiClient("/v1/system/info").catch(() => null),
      ]);
      if (projRes.ok) projects = await projRes.json();
      if (sysRes?.ok) systemInfo = await sysRes.json();
    } catch {}
    loading = false;
  });

  const activeCount = $derived(projects.filter(p => p.status === "active").length);
  const pausedCount = $derived(projects.filter(p => p.status === "paused").length);

  function getStatusColor(s: string) {
    if (s === "active") return "text-emerald-600 bg-emerald-500/10";
    if (s === "paused") return "text-amber-600 bg-amber-500/10";
    return "text-muted-foreground bg-muted/50";
  }
  function getStatusIcon(s: string) {
    if (s === "active") return CheckCircle2;
    if (s === "paused") return PauseCircle;
    return XCircle;
  }
  function timeAgo(dt: string): string {
    const diff = Date.now() - new Date(dt).getTime();
    const days = Math.floor(diff / 86400000);
    if (days > 30) return `${Math.floor(days / 30)} 个月前`;
    if (days > 0) return `${days} 天前`;
    const hours = Math.floor(diff / 3600000);
    if (hours > 0) return `${hours} 小时前`;
    return "刚刚";
  }
</script>

<div class="space-y-6">
  <!-- Welcome Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("GlobalDashboard.welcome")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("GlobalDashboard.subtitle")}</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={() => goto(resolve("/projects"))}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl bg-brand text-white shadow-md shadow-brand/20 hover:shadow-lg hover:brightness-110 transition-all">
        <Plus size={14} fill="currentColor" strokeWidth={1.5} />
        新建项目
      </button>
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- Stats Row -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow group">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{$t("GlobalDashboard.total_projects")}</span>
          <div class="w-9 h-9 rounded-xl bg-blue-500/10 flex items-center justify-center">
            <FolderKanban size={18} class="text-blue-600" fill="currentColor" strokeWidth={1.5} />
          </div>
        </div>
        <div class="mt-3 text-3xl font-bold">{projects.length}</div>
        <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span class="text-emerald-600 font-semibold">{activeCount} 运行中</span>
          {#if pausedCount > 0}
            <span>·</span>
            <span class="text-amber-600">{pausedCount} 已暂停</span>
          {/if}
        </div>
      </div>

      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow group">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{$t("GlobalDashboard.active_users")}</span>
          <div class="w-9 h-9 rounded-xl bg-violet-500/10 flex items-center justify-center">
            <Users size={18} class="text-violet-600" fill="currentColor" strokeWidth={1.5} />
          </div>
        </div>
        <div class="mt-3 text-3xl font-bold">{activeCount}</div>
        <div class="mt-1 text-xs text-muted-foreground">活跃项目数</div>
      </div>

      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow group">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{$t("GlobalDashboard.cpu_usage")}</span>
          <div class="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center">
            <Cpu size={18} class="text-amber-600" fill="currentColor" strokeWidth={1.5} />
          </div>
        </div>
        <div class="mt-3 text-3xl font-bold">{systemInfo.cpu || "-"}</div>
        <div class="mt-1 text-xs text-muted-foreground">{systemInfo.memory || "系统资源"}</div>
      </div>

      <div class="rounded-xl border bg-card p-5 shadow-sm hover:shadow-md transition-shadow group">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{$t("GlobalDashboard.storage")}</span>
          <div class="w-9 h-9 rounded-xl bg-teal-500/10 flex items-center justify-center">
            <HardDrive size={18} class="text-teal-600" fill="currentColor" strokeWidth={1.5} />
          </div>
        </div>
        <div class="mt-3 text-3xl font-bold">{systemInfo.version || "-"}</div>
        <div class="mt-1 text-xs text-muted-foreground">系统版本</div>
      </div>
    </div>

    <!-- Two Column: Projects + System -->
    <div class="grid gap-4 lg:grid-cols-3">
      <!-- Projects List (2/3) -->
      <div class="lg:col-span-2 rounded-xl border bg-card overflow-hidden">
        <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
          <h2 class="text-sm font-semibold flex items-center gap-2">
            <Server size={14} fill="currentColor" strokeWidth={1.5} />
            {$t("GlobalDashboard.recent_projects")}
          </h2>
          <a href={resolve("/projects")} class="text-[10px] text-brand hover:underline flex items-center gap-1 font-semibold">
            {$t("GlobalDashboard.view_all")} <ArrowRight size={10} />
          </a>
        </div>

        {#if projects.length === 0}
          <div class="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <FolderKanban size={40} strokeWidth={1} class="opacity-30" />
            <p class="text-sm">还没有项目</p>
            <button onclick={() => goto(resolve("/projects"))}
              class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:brightness-110 transition-all">
              <Plus size={12} /> 创建第一个项目
            </button>
          </div>
        {:else}
          <div class="divide-y">
            {#each projects as project (project.ref)}
              {@const StatusIcon = getStatusIcon(project.status)}
              <a href={resolve("/project/[ref]", { ref: project.ref })}
                class="flex items-center justify-between px-5 py-4 hover:bg-muted/30 transition-colors group cursor-pointer">
                <div class="flex items-center gap-4 flex-1 min-w-0">
                  <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-brand/20 to-purple-500/20 flex items-center justify-center text-brand font-bold text-sm shrink-0">
                    {project.name.charAt(0).toUpperCase()}
                  </div>
                  <div class="min-w-0">
                    <div class="font-semibold text-sm truncate group-hover:text-brand transition-colors">{project.name}</div>
                    <div class="text-[10px] text-muted-foreground font-mono">{project.ref}</div>
                  </div>
                </div>
                <div class="flex items-center gap-6 shrink-0">
                  <span class="text-[10px] text-muted-foreground hidden sm:block">{project.region || "local"}</span>
                  <span class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold {getStatusColor(project.status)}">
                    <StatusIcon size={10} fill="currentColor" strokeWidth={1.5} />
                    {project.status}
                  </span>
                  <div class="flex items-center gap-1 text-[10px] text-muted-foreground hidden md:flex">
                    <Clock size={10} />
                    {timeAgo(project.created_at)}
                  </div>
                  <ArrowUpRight size={14} class="text-muted-foreground/30 group-hover:text-brand transition-colors" />
                </div>
              </a>
            {/each}
          </div>
        {/if}
      </div>

      <!-- System Info (1/3) -->
      <div class="space-y-4">
        <div class="rounded-xl border bg-card overflow-hidden">
          <div class="border-b px-5 py-3 bg-muted/20">
            <h2 class="text-sm font-semibold flex items-center gap-2">
              <Activity size={14} fill="currentColor" strokeWidth={1.5} />
              系统状态
            </h2>
          </div>
          <div class="p-5 space-y-4">
            <div class="flex items-center justify-between">
              <span class="text-xs text-muted-foreground">运行时间</span>
              <span class="text-xs font-mono font-semibold">{systemInfo.uptime || "-"}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-muted-foreground">系统版本</span>
              <span class="text-xs font-mono font-semibold">{systemInfo.version || "-"}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-muted-foreground">项目总数</span>
              <span class="text-xs font-semibold">{projects.length}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-muted-foreground">活跃项目</span>
              <span class="text-xs font-semibold text-emerald-600">{activeCount}</span>
            </div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="rounded-xl border bg-card overflow-hidden">
          <div class="border-b px-5 py-3 bg-muted/20">
            <h2 class="text-sm font-semibold flex items-center gap-2">
              <RefreshCw size={14} fill="currentColor" strokeWidth={1.5} />
              快速操作
            </h2>
          </div>
          <div class="p-3 space-y-1">
            <a href={resolve("/projects")}
              class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium hover:bg-muted/50 transition-colors group">
              <div class="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <FolderKanban size={13} class="text-blue-600" fill="currentColor" strokeWidth={1.5} />
              </div>
              <span class="flex-1">管理所有项目</span>
              <ArrowRight size={12} class="text-muted-foreground/30 group-hover:text-brand transition-colors" />
            </a>
            <a href={resolve("/platform")}
              class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium hover:bg-muted/50 transition-colors group">
              <div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
                <Server size={13} class="text-violet-600" fill="currentColor" strokeWidth={1.5} />
              </div>
              <span class="flex-1">平台管理</span>
              <ArrowRight size={12} class="text-muted-foreground/30 group-hover:text-brand transition-colors" />
            </a>
            <a href={resolve("/platform/settings")}
              class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium hover:bg-muted/50 transition-colors group">
              <div class="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Cpu size={13} class="text-amber-600" fill="currentColor" strokeWidth={1.5} />
              </div>
              <span class="flex-1">AI 服务配置</span>
              <ArrowRight size={12} class="text-muted-foreground/30 group-hover:text-brand transition-colors" />
            </a>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
