<script lang="ts">
  import { apiClient, ensureMutationSucceeded } from "$lib/api";

  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { t } from "svelte-i18n";
  import { Loader2, Globe, ExternalLink, GitBranch, Clock, CheckCircle2, XCircle, RefreshCw, Trash2, Settings } from "lucide-svelte";
  import { useList, type BaseRecord } from "@svadmin/core";
  import { createMutation } from "@tanstack/svelte-query";

  interface Deployment extends BaseRecord {
    id: string;
    name: string;
    framework: string;
    domain: string;
    custom_domains: string[];
    status: string;
    deployment_url: string;
    git_url?: string;
    git_branch?: string;
    last_deployed_at?: string;
    created_at: string;
  }

  const projectRef = $derived(page.params.ref);
  const query = useList<Deployment>({ get resource() { return `v1/projects/${projectRef}/frontend/deployments`; } });
  const deployments = $derived(Array.isArray(query.data?.data) ? query.data.data : ((query.data?.data as unknown as Record<string, unknown>)?.deployments as Deployment[] || []));

  let actionMsg: string | null = $state.raw(null);

  const redeployMutation = createMutation(() => ({
    mutationFn: async (id: string) => {
      const response = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${id}/redeploy`, { method: "POST" });
      await ensureMutationSucceeded(response, "部署失败");
      return true;
    },
    onSuccess: () => {
      actionMsg = `✅ 重新部署已触发`;
      query.refetch();
      setTimeout(() => actionMsg = null, 5000);
    },
    onError: (err: unknown) => {
      actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => actionMsg = null, 5000);
    }
  }));

  function redeploy(id: string) {
    actionMsg = null;
    redeployMutation.mutate(id);
  }

  let deletingId: string | null = $state.raw(null);

  const deleteMutation = createMutation(() => ({
    mutationFn: async (id: string) => {
      const response = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${id}`, { method: "DELETE" });
      await ensureMutationSucceeded(response, "删除部署失败");
      return true;
    },
    onMutate: (id) => {
      deletingId = id;
    },
    onSuccess: () => {
      actionMsg = "✅ 部署已删除";
      query.refetch();
    },
    onError: (error: unknown) => {
      actionMsg = `❌ ${error instanceof Error ? error.message : String(error)}`;
    },
    onSettled: () => {
      deletingId = null;
      setTimeout(() => actionMsg = null, 3000);
    }
  }));

  function deleteDeployment(id: string) {
    if (!confirm("确定要删除此部署吗？这将停止服务并删除所有相关文件。")) return;
    deleteMutation.mutate(id);
  }


  function getStatusIcon(status: string): string {
    if (status === "success") return "text-green-600";
    if (status === "building" || status === "pending") return "text-amber-600";
    return "text-red-600";
  }

  function getFrameworkLabel(fw: string): string {
    const map: Record<string, string> = {
      static: "静态站点", react: "React", vue: "Vue", svelte: "Svelte",
      nextjs: "Next.js", nuxt: "Nuxt", sveltekit: "SvelteKit", astro: "Astro", remix: "Remix"
    };
    return map[fw] || fw;
  }

  function timeAgo(dateStr: string): string {
    if (!dateStr) return "—";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-bold">站点列表</h2>
    <div class="flex items-center gap-2">
      <button onclick={() => query.refetch()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <RefreshCw size={12} /> {$t("Hosting.refresh")}
      </button>
      {#if deployments.length > 0}
        <a href={`/project/${projectRef}/hosting/new`} class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
          + {$t("Hosting.new_deploy")}
        </a>
      {/if}
    </div>
  </div>

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  {#if query.isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if deployments.length === 0}
    <div class="rounded-xl border bg-card p-12 text-center">
      <Globe size={48} class="mx-auto text-muted-foreground/30 mb-4" />
      <h3 class="text-lg font-bold mb-2">{$t("Hosting.no_deployments")}</h3>
      <p class="text-xs text-muted-foreground mb-4">{$t("Hosting.no_deployments_desc")}</p>
      <a href={`/project/${projectRef}/hosting/new`} class="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
        + {$t("Hosting.new_deploy")}
      </a>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each deployments as dep}
        <div class="rounded-xl border bg-card overflow-hidden hover:border-brand/30 transition-all">
          <div class="p-5">
            <div class="flex items-start justify-between mb-3">
              <div>
                <div class="flex items-center gap-2">
                  <h3 class="text-sm font-bold">{dep.name}</h3>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-brand/10 text-brand">{getFrameworkLabel(dep.framework)}</span>
                </div>
                {#if dep.deployment_url}
                  <a href={dep.deployment_url} target="_blank" rel="noopener noreferrer" class="text-[11px] text-brand hover:underline flex items-center gap-1 mt-1">
                    <ExternalLink size={10} /> {dep.deployment_url}
                  </a>
                {/if}
              </div>
              <div class="flex items-center gap-1">
                {#if dep.status === "success"}<CheckCircle2 size={16} class="text-green-500" />
                {:else if dep.status === "building" || dep.status === "pending"}<Loader2 size={16} class="text-amber-500 animate-spin" />
                {:else}<XCircle size={16} class="text-red-500" />{/if}
              </div>
            </div>

            {#if dep.git_url}
              <div class="flex items-center gap-2 text-[10px] text-muted-foreground mb-2">
                <GitBranch size={10} />
                <span class="font-mono truncate max-w-48">{dep.git_url}</span>
                {#if dep.git_branch}<span class="px-1.5 py-0.5 rounded bg-muted text-[9px]">{dep.git_branch}</span>{/if}
              </div>
            {/if}

            {#if dep.custom_domains?.length > 0}
              <div class="flex flex-wrap gap-1 mb-2">
                {#each dep.custom_domains as domain}
                  <span class="px-2 py-0.5 rounded-full text-[10px] bg-green-500/10 text-green-600 border border-green-500/20">{domain}</span>
                {/each}
              </div>
            {/if}

            <div class="flex items-center gap-3 text-[10px] text-muted-foreground mt-3">
              <span class="flex items-center gap-1"><Clock size={10} /> {dep.last_deployed_at ? timeAgo(dep.last_deployed_at) : '未部署'}</span>
            </div>
          </div>

          <div class="border-t px-4 py-2.5 bg-muted/10 flex items-center justify-between">
            <div class="flex items-center gap-1">
              <button onclick={() => goto(`/project/${projectRef}/hosting/${dep.id}`)} class="px-2.5 py-1 text-[10px] font-semibold rounded-md hover:bg-muted/50 transition-colors">
                <Settings size={10} class="inline mr-1" />设置
              </button>
              <button onclick={() => goto(`/project/${projectRef}/hosting/${dep.id}/records`)} class="px-2.5 py-1 text-[10px] font-semibold rounded-md hover:bg-muted/50 transition-colors">
                📋 记录
              </button>
            </div>
            <div class="flex items-center gap-1">
              <button onclick={() => redeploy(dep.id)} class="px-2.5 py-1 text-[10px] font-semibold rounded-md text-brand hover:bg-brand/10 transition-colors">
                ↻ 重新部署
              </button>
              <button onclick={() => deleteDeployment(dep.id)} disabled={deletingId === dep.id} class="px-2.5 py-1 text-[10px] font-semibold rounded-md text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50">
                {#if deletingId === dep.id}<Loader2 size={10} class="animate-spin inline" />{/if} 删除
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Webhook Info -->
  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Globe size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <div class="text-xs text-blue-700">
      <b>{$t("Hosting.webhook_info")}：</b> {$t("Hosting.webhook_support")}
      {$t("Hosting.webhook_url_label")}
      <code class="px-1 py-0.5 rounded bg-blue-500/10">{`${typeof window !== 'undefined' ? window.location.origin : ''}/v1/webhooks/{github|gitlab|gitee|gitcode}`}</code>。
      {$t("Hosting.webhook_trigger")}
    </div>
  </div>
</div>
