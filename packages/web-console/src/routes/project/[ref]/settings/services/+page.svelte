<script lang="ts">
  import { apiClient } from "$lib/api";

  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Loader2, Play, Square, RotateCw, Activity, Server, Shield, Database, Radio, HardDrive, AlertTriangle } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { useShow } from "@svadmin/core";
  import { useQueryClient, createMutation } from "@tanstack/svelte-query";

  interface ServiceInfo {
    name: string;
    icon: typeof Server;
    status: string;
    systemdUnit: string;
    controlName: string;
    runtimeMode?: "local" | "owner" | "shared";
    managedByRef?: string;
    localRuntimeEnabled?: boolean;
  }

  let actionInProgress = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);

  const query = useShow({
    get resource() { return "v1/projects"; },
    get id() { return projectRef; }
  });

  const queryClient = useQueryClient();

  const services = $derived.by(() => {
    const data = query.data?.data as Record<string, any>;
    const svcArr = data?.services || [];
    const findService = (name: string) => svcArr.find((service: Record<string, unknown>) => service.name === name);
    const authService = svcArr.find((service: Record<string, unknown>) =>
      service.id === "gotrue"
      || service.id === "auth"
      || service.name === "GoTrue"
      || service.name === "auth"
    );
    const authRuntimeMode = authService?.runtime_mode === "shared"
      ? "shared"
      : authService?.runtime_mode === "owner"
        ? "owner"
        : "local";
    const authOwnerRef = typeof authService?.managed_by_ref === "string" ? authService.managed_by_ref : undefined;
    return [
      { name: "PostgreSQL", controlName: "postgresql", icon: Database, status: findService("PostgreSQL")?.status || "INACTIVE", systemdUnit: "patroni" },
      { name: "PostgREST", controlName: "postgrest", icon: Server, status: findService("PostgREST")?.status || "INACTIVE", systemdUnit: `supacloud-pgrst@${projectRef}` },
      {
        name: authRuntimeMode === "shared"
          ? "SupAuth（共享）"
          : authRuntimeMode === "owner"
            ? "SupAuth（权威）"
            : "GoTrue",
        controlName: "gotrue",
        icon: Shield,
        status: authService?.status || "INACTIVE",
        systemdUnit: authService?.unit || `supacloud-gotrue@${authOwnerRef || projectRef}`,
        runtimeMode: authRuntimeMode,
        managedByRef: authOwnerRef,
        localRuntimeEnabled: authService?.local_runtime_enabled !== false,
      },
      { name: "Realtime", controlName: "realtime", icon: Radio, status: findService("Realtime")?.status || "INACTIVE", systemdUnit: `supacloud-realtime@${projectRef}` },
      { name: "Storage", controlName: "storage", icon: HardDrive, status: findService("Storage")?.status || "INACTIVE", systemdUnit: `supacloud-storage@${projectRef}` },
      { name: "Caddy", controlName: "caddy", icon: Activity, status: findService("Caddy")?.status || "INACTIVE", systemdUnit: "supacloud-caddy" },
    ];
  });

  const sharedAuthService = $derived(services.find((service) => service.runtimeMode === "shared"));
  const ownerAuthService = $derived(services.find((service) => service.runtimeMode === "owner"));

  const isLoading = $derived(query.isLoading);

  async function refetchServices() {
    await queryClient.invalidateQueries({ queryKey: ["v1/projects", "getOne", projectRef] });
  }

  const actionMutation = createMutation(() => ({
    mutationFn: async ({ type, serviceName }: { type: string, serviceName?: string }) => {
      let url = "";
      if (type === "restart") url = `/v1/projects/${projectRef}/restart`;
      else if (type === "pause") url = `/v1/projects/${projectRef}/pause`;
      else if (type === "restore") url = `/v1/projects/${projectRef}/restore`;
      else if (['start', 'stop', 'restart-svc'].includes(type) && serviceName) {
        const action = type === 'restart-svc' ? 'restart' : type;
        url = `/v1/projects/${projectRef}/services/${serviceName}/${action}`;
      }
      
      const res = await apiClient(url, { method: "POST" });
      if (!res.ok) throw new Error(`${type} failed`);
      await new Promise(r => setTimeout(r, type === "pause" ? 1000 : 2000));
      return { type, serviceName };
    },
    onMutate: (variables) => {
      actionInProgress = variables.type === 'restart-svc' ? `restart-${variables.serviceName}` : `${variables.type}${variables.serviceName ? '-' + variables.serviceName : ''}`;
    },
    onSuccess: () => {
      refetchServices();
    },
    onError: () => {
      toast.error("操作失败");
    },
    onSettled: () => {
      actionInProgress = null;
    }
  }));

  function restartProject() {
    actionMutation.mutate({ type: "restart" });
  }

  function pauseProject() {
    actionMutation.mutate({ type: "pause" });
  }

  function restoreProject() {
    actionMutation.mutate({ type: "restore" });
  }

  function controlService(action: "start" | "stop" | "restart", serviceName: string) {
    const type = action === "restart" ? "restart-svc" : action;
    actionMutation.mutate({ type, serviceName });
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
        onclick={restoreProject}
        disabled={!!actionInProgress}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
      >
        {#if actionInProgress === "restore"}<Loader2 size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
        启动全部
      </button>
      <button 
        onclick={restartProject}
        disabled={!!actionInProgress}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
      >
        {#if actionInProgress === "restart"}<Loader2 size={14} class="animate-spin" />{:else}<RotateCw size={14} />{/if}
        重启全部
      </button>
      <button 
        onclick={pauseProject}
        disabled={!!actionInProgress}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border border-destructive text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
      >
        {#if actionInProgress === "pause"}<Loader2 size={14} class="animate-spin" />{:else}<Square size={14} />{/if}
        暂停项目
      </button>
    </div>
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">
      所有服务通过 <code class="text-[10px]">systemd</code> 管理。
      <strong>启动全部</strong> 会调用 <code class="text-[10px]">POST /v1/projects/{projectRef}/restore</code>，
      <strong>重启全部</strong> 会调用 <code class="text-[10px]">POST /v1/projects/{projectRef}/restart</code>。
    </p>
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
                {#if svc.runtimeMode === "shared"}
                  <span class="text-[10px] font-semibold text-muted-foreground">只读</span>
                {:else if svc.status === "ACTIVE_HEALTHY"}
                  <button
                    onclick={() => controlService("restart", svc.controlName)}
                    disabled={!!actionInProgress}
                    class="p-1.5 hover:bg-brand/10 hover:text-brand rounded transition-colors disabled:opacity-50"
                    title="重启"
                  >
                    <RotateCw size={14} />
                  </button>
                  <button
                    onclick={() => controlService("stop", svc.controlName)}
                    disabled={!!actionInProgress}
                    class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded transition-colors disabled:opacity-50"
                    title="停止"
                  >
                    <Square size={14} />
                  </button>
                {:else}
                  <button
                    onclick={() => controlService("start", svc.controlName)}
                    disabled={!!actionInProgress}
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
