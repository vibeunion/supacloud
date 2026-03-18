<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Loader2, Globe, ExternalLink, GitBranch, Clock, CheckCircle2, XCircle, RefreshCw, Trash2, Settings, AlertTriangle } from "lucide-svelte";

  interface Deployment {
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

  let deployments: Deployment[] = $state([]);
  let isLoading = $state(true);
  let actionMsg: string | null = $state(null);
  let deletingId: string | null = $state(null);

  const projectRef = $derived(page.params.ref);

  async function fetchDeployments() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments`);
      if (res.ok) {
        const data = await res.json();
        deployments = data.deployments || [];
      }
    } catch {}
    isLoading = false;
  }

  async function redeploy(id: string) {
    actionMsg = null;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${id}/redeploy`, { method: "POST" });
      const data = await res.json();
      actionMsg = data.success !== false ? `✅ 重新部署已触发` : `❌ ${data.error || '部署失败'}`;
      await fetchDeployments();
    } catch (err: any) {
      actionMsg = `❌ ${err.message}`;
    }
    setTimeout(() => actionMsg = null, 5000);
  }

  async function deleteDeployment(id: string) {
    if (!confirm("确定要删除此部署吗？这将停止服务并删除所有相关文件。")) return;
    deletingId = id;
    try {
      await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${id}`, { method: "DELETE" });
      actionMsg = "✅ 部署已删除";
      await fetchDeployments();
    } catch {}
    deletingId = null;
    setTimeout(() => actionMsg = null, 3000);
  }

  onMount(() => fetchDeployments());

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
      <button onclick={() => fetchDeployments()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <RefreshCw size={12} /> 刷新
      </button>
      <a href={`/project/${projectRef}/hosting/new`} class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
        + 新建部署
      </a>
    </div>
  </div>

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if deployments.length === 0}
    <div class="rounded-xl border bg-card p-12 text-center">
      <Globe size={48} class="mx-auto text-muted-foreground/30 mb-4" />
      <h3 class="text-lg font-bold mb-2">还没有任何部署</h3>
      <p class="text-xs text-muted-foreground mb-4">创建你的第一个前端部署 — 支持静态站点、React、Vue、Next.js、SvelteKit 等</p>
      <a href={`/project/${projectRef}/hosting/new`} class="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
        + 新建部署
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
      <b>Webhook 自动部署：</b>支持 GitHub、GitLab、Gitee、GitCode 四大平台。
      在仓库设置中添加 Webhook URL：
      <code class="px-1 py-0.5 rounded bg-blue-500/10">{`${typeof window !== 'undefined' ? window.location.origin : ''}/v1/webhooks/{github|gitlab|gitee|gitcode}`}</code>，
      Push 事件将自动触发匹配的部署。
    </div>
  </div>
</div>
