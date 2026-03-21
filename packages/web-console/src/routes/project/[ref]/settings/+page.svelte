<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Activity, Server, Pause, RotateCw, Trash2, AlertTriangle } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  let project = $state<Record<string, unknown> | null>(null);
  let isLoading = $state(true);
  let actionInProgress = $state<string | null>(null);
  let actionMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);

  async function fetchProject() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}`);
      project = await res.json();
    } catch (err: unknown) {
      toast.error("无法fetch project");
    } finally {
      isLoading = false;
    }
  }

  async function restartProject() {
    actionInProgress = "restart";
    try {
      await apiClient(`/v1/projects/${projectRef}/restart`, { method: "POST" });
      actionMsg = "✅ 项目重启请求已发送";
      await new Promise(r => setTimeout(r, 2000));
      await fetchProject();
    } catch {
      actionMsg = "❌ 重启失败";
    } finally {
      actionInProgress = null;
      setTimeout(() => actionMsg = null, 4000);
    }
  }

  async function pauseProject() {
    if (!confirm("确定要暂停项目？暂停后所有服务将停止。")) return;
    actionInProgress = "pause";
    try {
      await apiClient(`/v1/projects/${projectRef}/pause`, { method: "POST" });
      actionMsg = "✅ 项目已暂停";
      await fetchProject();
    } catch {
      actionMsg = "❌ 暂停失败";
    } finally {
      actionInProgress = null;
      setTimeout(() => actionMsg = null, 4000);
    }
  }

  async function restoreProject() {
    actionInProgress = "restore";
    try {
      await apiClient(`/v1/projects/${projectRef}/restore`, { method: "POST" });
      actionMsg = "✅ 项目已恢复";
      await new Promise(r => setTimeout(r, 2000));
      await fetchProject();
    } catch {
      actionMsg = "❌ 恢复失败";
    } finally {
      actionInProgress = null;
      setTimeout(() => actionMsg = null, 4000);
    }
  }

  async function deleteProject() {
    const input = prompt(`请输入项目名称以确认删除：\n[ ${project?.name} ]`);
    if (input !== project?.name) {
      actionMsg = "❌ 项目名称不匹配，已取消删除";
      setTimeout(() => actionMsg = null, 4000);
      return;
    }
    if (!confirm("再次确认：所有数据（数据库、存储、认证用户）都将被永久删除。此操作不可撤销！")) return;
    actionInProgress = "delete";
    try {
      const res = await apiClient(`/v1/projects/${projectRef}`, { method: "DELETE" });
      if (res.ok) {
        actionMsg = "✅ 项目已删除。正在跳转...";
        setTimeout(() => { window.location.href = "/"; }, 2000);
      } else {
        actionMsg = "❌ 删除失败";
      }
    } catch {
      actionMsg = "❌ 删除失败";
    } finally {
      actionInProgress = null;
    }
  }

  onMount(() => {
    fetchProject();
  });
</script>

<div class="flex flex-col space-y-6">

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if project}
    <div class="space-y-6">
      <!-- General -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <h2 class="text-lg font-semibold">{$t("Settings.general")}</h2>
        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span class="text-xs text-muted-foreground">{$t("Settings.project_name")}</span>
            <p class="font-medium">{project.name}</p>
          </div>
          <div>
            <span class="text-xs text-muted-foreground">{$t("Settings.project_ref")}</span>
            <p class="font-mono text-xs">{project.ref}</p>
          </div>
          <div>
            <span class="text-xs text-muted-foreground">{$t("Settings.region")}</span>
            <p>{project.region}</p>
          </div>
          <div>
            <span class="text-xs text-muted-foreground">{$t("Settings.status")}</span>
            <span class="px-2 py-0.5 {project.status === 'active' ? 'bg-green-500/10 text-green-600' : 'bg-amber-500/10 text-amber-600'} text-xs rounded-full">{project.status}</span>
          </div>
        </div>
      </div>

      <!-- Services -->
      {#if (project as Record<string, unknown>)?.services}
        <div class="border rounded-xl bg-card p-6 space-y-4">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <Server size={16} />
            {$t("Settings.services")}
          </h2>
          <div class="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {#each ((project as Record<string, unknown>)?.services as unknown[] || []) as service}
              <div class="flex items-center justify-between p-3 rounded-lg border bg-background">
                <div class="flex items-center gap-2">
                  <Activity size={14} class={(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? 'text-green-500' : 'text-muted-foreground'} />
                  <span class="text-sm font-medium">{(service as Record<string, unknown>).name}</span>
                </div>
                <span class="text-[10px] px-2 py-0.5 rounded-full {(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground'}">
                  {(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? $t("Settings.active") : $t("Settings.inactive")}
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Database Info -->
      {#if (project as Record<string, unknown>)?.database}
        <div class="border rounded-xl bg-card p-6 space-y-4">
          <h2 class="text-lg font-semibold">{$t("Settings.database_info")}</h2>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span class="text-xs text-muted-foreground">PostgreSQL</span>
              <p class="font-mono text-xs">v{((project as Record<string, unknown>)?.database as Record<string, unknown>)?.version}</p>
            </div>
            <div>
              <span class="text-xs text-muted-foreground">{$t("Dashboard.db_connections")}</span>
              <p class="font-mono text-xs">{((project as Record<string, unknown>)?.database as Record<string, unknown>)?.connection_count}</p>
            </div>
            <div>
              <span class="text-xs text-muted-foreground">{$t("Settings.db_size")}</span>
              <p class="font-mono text-xs">{(((project as Record<string, unknown>)?.database as Record<string, unknown>)?.size as number / 1024 / 1024).toFixed(1)} MB</p>
            </div>
          </div>
        </div>
      {/if}

      <!-- Project Actions -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <h2 class="text-lg font-semibold">项目操作</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button onclick={restartProject} disabled={!!actionInProgress}
            class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
            {#if actionInProgress === "restart"}<Loader2 size={16} class="animate-spin" />{:else}<RotateCw size={16} />{/if}
            重启项目
          </button>
          {#if (project as Record<string, unknown>)?.status === "active"}
            <button onclick={pauseProject} disabled={!!actionInProgress}
              class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg border border-amber-500 text-amber-600 hover:bg-amber-500/10 transition-colors disabled:opacity-50">
              {#if actionInProgress === "pause"}<Loader2 size={16} class="animate-spin" />{:else}<Pause size={16} />{/if}
              暂停项目
            </button>
          {:else}
            <button onclick={restoreProject} disabled={!!actionInProgress}
              class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50">
              {#if actionInProgress === "restore"}<Loader2 size={16} class="animate-spin" />{:else}<Activity size={16} />{/if}
              恢复项目
            </button>
          {/if}
        </div>
      </div>

      <!-- Danger Zone -->
      <div class="border border-destructive/30 rounded-xl bg-destructive/5 p-6 space-y-4">
        <div class="flex items-center gap-2">
          <AlertTriangle size={16} class="text-destructive" />
          <h2 class="text-lg font-semibold text-destructive">危险区域</h2>
        </div>
        <p class="text-xs text-muted-foreground">删除项目将永久移除所有数据、数据库、存储文件和认证用户。此操作不可撤销。</p>
        <button onclick={deleteProject} disabled={!!actionInProgress}
          class="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-destructive text-white hover:bg-destructive/90 transition-colors disabled:opacity-50">
          {#if actionInProgress === "delete"}<Loader2 size={16} class="animate-spin" />{:else}<Trash2 size={16} />{/if}
          删除项目
        </button>
      </div>
    </div>
  {/if}
</div>

