<script lang="ts">
  import { onDestroy } from "svelte";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Loader2, Play, Square, RotateCw, Activity, Server, Shield, Database, Radio, HardDrive, AlertTriangle, RefreshCw } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { apiClient } from "$lib/api";
  import {
    loadServiceControlState,
    runServiceOperation,
    type ServiceControlState,
    type ServiceId,
    type ServiceOperation,
  } from "$lib/project-services";

  const projectRef = $derived(page.params.ref ?? "");

  let snapshot = $state<ServiceControlState | null>(null);
  let isLoading = $state(true);
  let error = $state(false);
  let actionInProgress = $state<string | null>(null);
  let controller: AbortController | null = null;
  let loadedRef = "";

  const META: Record<ServiceId, { name: string; icon: typeof Server }> = {
    postgresql: { name: "PostgreSQL", icon: Database },
    postgrest: { name: "PostgREST", icon: Server },
    gotrue: { name: "GoTrue", icon: Shield },
    realtime: { name: "Realtime", icon: Radio },
    storage: { name: "Storage", icon: HardDrive },
    caddy: { name: "Caddy", icon: Activity },
  };

  async function load(): Promise<void> {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    isLoading = true;
    error = false;
    if (!projectRef) {
      snapshot = null;
      loadedRef = "";
      isLoading = false;
      return;
    }
    loadedRef = projectRef;
    try {
      const next = await loadServiceControlState(projectRef, apiClient, current.signal);
      if (controller !== current) return;
      snapshot = next;
      error = false;
    } catch {
      if (controller !== current) return;
      snapshot = null;
      error = true;
    } finally {
      if (controller === current) isLoading = false;
    }
  }

  $effect(() => {
    const ref = projectRef;
    if (ref !== loadedRef) void load();
  });

  onDestroy(() => {
    controller?.abort();
  });

  const services = $derived((snapshot?.services ?? []).map((svc) => {
    const mode = svc.runtimeMode;
    const name = svc.id === "gotrue"
      ? mode === "shared" ? "SupAuth（共享）" : mode === "owner" ? "SupAuth（权威）" : "GoTrue"
      : META[svc.id].name;
    return {
      name,
      icon: META[svc.id].icon,
      status: svc.status,
      controlName: svc.id,
      systemdUnit: svc.controlUnit,
      runtimeMode: mode,
      managedByRef: svc.managedByRef,
      controllable: svc.controllable,
    };
  }));

  const sharedAuthService = $derived(services.find((service) => service.runtimeMode === "shared"));
  const ownerAuthService = $derived(services.find((service) => service.runtimeMode === "owner"));
  const canPause = $derived(Boolean(snapshot) && snapshot?.authRuntime.mode !== "owner");
  const busy = $derived(actionInProgress !== null || isLoading || error || !snapshot);

  async function run(operation: ServiceOperation, key: string): Promise<void> {
    if (!snapshot || actionInProgress) return;
    const active = snapshot;
    const current = controller;
    actionInProgress = key;
    try {
      await runServiceOperation(active, operation, apiClient,
        current?.signal ?? new AbortController().signal);
      if (controller === current) await load();
    } catch {
      if (controller === current) toast.error("操作失败");
    } finally {
      if (actionInProgress === key) actionInProgress = null;
    }
  }

  function refresh() {
    void load();
  }

  function restartProject() {
    void run({ kind: "project", action: "restart" }, "restart");
  }

  function pauseProject() {
    void run({ kind: "project", action: "pause" }, "pause");
  }

  function restoreProject() {
    void run({ kind: "project", action: "restore" }, "restore");
  }

  function controlService(action: "start" | "stop" | "restart", service: ServiceId) {
    void run({ kind: "service", service, action }, `${action}:${service}`);
  }

  function statusColor(status: string): string {
    if (status === "ACTIVE_HEALTHY") return "text-green-600 bg-green-500/10";
    if (status === "INACTIVE") return "text-muted-foreground bg-muted/50";
    return "text-amber-600 bg-amber-500/10";
  }

  function statusLabel(status: string): string {
    if (status === "ACTIVE_HEALTHY") return "运行中";
    if (status === "INACTIVE") return "已停止";
    return status;
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">服务控制</h1>
      <p class="text-sm text-muted-foreground mt-1">管理项目各组件的运行状态，执行启动、停止和重启操作</p>
    </div>
    <div class="flex items-center gap-2">
      <button
        onclick={refresh}
        disabled={isLoading}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50"
      >
        {#if isLoading}<Loader2 size={14} class="animate-spin" />{:else}<RefreshCw size={14} />{/if}
        刷新
      </button>
      <button
        onclick={restoreProject}
        disabled={busy}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
      >
        {#if actionInProgress === "restore"}<Loader2 size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
        启动全部
      </button>
      <button
        onclick={restartProject}
        disabled={busy}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
      >
        {#if actionInProgress === "restart"}<Loader2 size={14} class="animate-spin" />{:else}<RotateCw size={14} />{/if}
        重启全部
      </button>
      <button
        onclick={pauseProject}
        disabled={busy || !canPause}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border border-destructive text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
      >
        {#if actionInProgress === "pause"}<Loader2 size={14} class="animate-spin" />{:else}<Square size={14} />{/if}
        暂停项目
      </button>
    </div>
  </div>

  {#if error}
    <div class="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive" role="alert">
      服务控制状态不可用，请刷新后重试。
    </div>
  {/if}

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <div class="space-y-1.5 text-xs text-blue-700">
      <p>所有服务通过 <code class="rounded bg-blue-600/10 px-1.5 py-0.5 font-mono text-[11px] text-blue-950">systemd</code> 管理。</p>
      <ul class="space-y-1">
        <li><span class="font-medium">启动全部</span> 会调用 <code class="rounded bg-blue-600/10 px-1.5 py-0.5 font-mono text-[11px] text-blue-950">POST /v1/projects/{projectRef}/restore</code></li>
        <li><span class="font-medium">重启全部</span> 会调用 <code class="rounded bg-blue-600/10 px-1.5 py-0.5 font-mono text-[11px] text-blue-950">POST /v1/projects/{projectRef}/restart</code></li>
      </ul>
    </div>
  </div>

  {#if sharedAuthService}
    <div class="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2">
      <Shield size={14} class="text-amber-700 mt-0.5 shrink-0" />
      <p class="text-xs leading-5 text-amber-950">
        本项目使用 SupAuth 共享认证，本地 GoTrue 已停用。公开认证流量与认证状态来自权威项目
        {#if sharedAuthService.managedByRef}
          <a
            class="font-mono font-semibold underline underline-offset-2"
            href={resolve("/project/[ref]/auth", { ref: sharedAuthService.managedByRef })}
          >
            {sharedAuthService.managedByRef}
          </a>
        {:else}
          <span class="font-semibold">SupAuth 权威项目</span>
        {/if}；启动全部、重启全部和暂停项目不会控制该共享认证服务。
      </p>
    </div>
  {:else if ownerAuthService}
    <div class="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 flex items-start gap-2">
      <Shield size={14} class="text-blue-700 mt-0.5 shrink-0" />
      <p class="text-xs leading-5 text-blue-950">
        本项目运行 SupAuth 权威 GoTrue。对该服务及认证设置的操作会影响所有从属项目，请按共享基础设施变更处理。
      </p>
    </div>
  {/if}

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在查询服务状态...</p>
      </div>
    {:else}
      <div class="divide-y divide-border/20">
        {#each services as svc (svc.name)}
          <div class="flex items-center justify-between px-6 py-4 hover:bg-muted/5 transition-colors">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg flex items-center justify-center {svc.status === 'ACTIVE_HEALTHY' ? 'bg-green-500/10 text-green-600' : 'bg-muted/50 text-muted-foreground'}">
                <svc.icon size={18} />
              </div>
              <div>
                <span class="font-semibold text-sm">{svc.name}</span>
                <p class="text-[10px] font-mono text-muted-foreground">{svc.systemdUnit}</p>
                {#if svc.runtimeMode === "shared"}
                  <p class="text-[10px] text-amber-700">由项目 {svc.managedByRef} 统一管理，本地实例不可操作</p>
                {:else if svc.runtimeMode === "owner"}
                  <p class="text-[10px] text-blue-700">共享认证权威实例，变更会影响所有从属项目</p>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-3">
              <span class="px-2.5 py-1 rounded-full text-[10px] font-bold {statusColor(svc.status)}">{statusLabel(svc.status)}</span>
              <div class="flex items-center gap-1 min-w-14 justify-end">
                {#if !svc.controllable}
                  <span class="text-[10px] font-semibold text-muted-foreground">只读</span>
                {:else if svc.status === "ACTIVE_HEALTHY"}
                  <button
                    onclick={() => controlService("restart", svc.controlName)}
                    disabled={busy}
                    class="p-1.5 hover:bg-brand/10 hover:text-brand rounded transition-colors disabled:opacity-50"
                    title="重启"
                  >
                    <RotateCw size={14} />
                  </button>
                  <button
                    onclick={() => controlService("stop", svc.controlName)}
                    disabled={busy}
                    class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded transition-colors disabled:opacity-50"
                    title="停止"
                  >
                    <Square size={14} />
                  </button>
                {:else}
                  <button
                    onclick={() => controlService("start", svc.controlName)}
                    disabled={busy}
                    class="p-1.5 hover:bg-green-500/10 hover:text-green-600 rounded transition-colors disabled:opacity-50"
                    title="启动"
                  >
                    <Play size={14} />
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>