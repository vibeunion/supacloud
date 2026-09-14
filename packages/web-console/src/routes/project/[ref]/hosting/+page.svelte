<script lang="ts">
  import { apiClient } from "$lib/api";
  import { isHostingId, loadHostingList, type HostingDeployment } from "$lib/hosting-list";
  import { runHostingMutation } from "$lib/hosting-mutations";
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { t } from "svelte-i18n";
  import Loader2 from "lucide-svelte/icons/loader-circle";
  import Globe from "lucide-svelte/icons/globe";
  import ExternalLink from "lucide-svelte/icons/external-link";
  import GitBranch from "lucide-svelte/icons/git-branch";
  import Clock from "lucide-svelte/icons/clock";
  import CheckCircle2 from "lucide-svelte/icons/circle-check";
  import XCircle from "lucide-svelte/icons/circle-x";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import Settings from "lucide-svelte/icons/settings";

  const projectRef = $derived(page.params.ref);
  let deployments = $state<HostingDeployment[]>([]);
  let loading = $state(true);
  let loadError = $state(false);
  type Operation = "redeploy" | "delete_deployment";
  let pending = $state.raw(new Map<string, Operation>());
  type Scope = { ref: string; controller: AbortController; read: AbortController | null };
  let scope: Scope | null = null;
  const isCurrent = (current: Scope) =>
    scope === current && projectRef === current.ref && !current.controller.signal.aborted;

  let actionMsg: string | null = $state.raw(null);

  async function loadDeployments() {
    const current = scope;
    if (!current || !isCurrent(current)) return;
    current.read?.abort();
    const read = new AbortController();
    current.read = read;
    const valid = () => isCurrent(current) && current.read === read;
    loading = true;
    loadError = false;
    deployments = [];
    try {
      const rows = await loadHostingList(current.ref, apiClient,
        AbortSignal.any([read.signal, current.controller.signal]));
      if (valid()) deployments = rows;
    } catch {
      if (valid()) loadError = true;
    } finally {
      read.abort();
      if (valid()) {
        current.read = null;
        loading = false;
      }
    }
  }

  $effect(() => {
    const ref = projectRef;
    deployments = [];
    pending = new Map();
    actionMsg = null;
    loading = false;
    loadError = !isHostingId(ref);
    if (!isHostingId(ref)) { scope = null; return; }
    const current: Scope = { ref, controller: new AbortController(), read: null };
    scope = current;
    untrack(() => { void loadDeployments(); });
    return () => { current.controller.abort(); current.read?.abort(); };
  });

  async function mutateDeployment(id: string, operation: Operation) {
    const current = scope;
    if (!current || !isCurrent(current) || pending.has(id) || !deployments.some(row => row.id === id)) return;
    pending = new Map(pending).set(id, operation);
    actionMsg = null;
    try {
      await runHostingMutation(current.ref, id, { operation }, { signal: current.controller.signal });
      if (!isCurrent(current)) return;
      actionMsg = operation === "redeploy" ? "✅ 重新部署已完成" : "✅ 部署已删除";
      void loadDeployments();
    } catch (error) {
      if (isCurrent(current)) actionMsg = `❌ ${error instanceof Error ? error.message : "操作无法确认"}`;
    } finally {
      if (isCurrent(current)) {
        const remaining = new Map(pending);
        remaining.delete(id);
        pending = remaining;
      }
    }
  }

  function deleteDeployment(id: string) {
    if (pending.has(id)) return;
    if (!confirm("确定要删除此部署吗？这将停止服务并删除所有相关文件。")) return;
    void mutateDeployment(id, "delete_deployment");
  }


  function getStatusIcon(status: string): string {
    if (status === "success") return "text-green-600";
    if (status === "building" || status === "pending") return "text-amber-600";
    return "text-red-600";
  }

  function getFrameworkLabel(fw: string): string {
    const map: Record<string, string> = {
      static: "静态站点", react: "React", vue: "Vue", svelte: "Svelte",
      nextjs: "Next.js", nuxt: "Nuxt", sveltekit: "SvelteKit", "sveltekit-static": "SvelteKit Static", astro: "Astro", remix: "Remix"
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
      <button onclick={() => loadDeployments()} disabled={loading || !isHostingId(projectRef)} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50">
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

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if loadError}
    <div role="alert" class="border-l-2 border-red-500 px-4 py-3 text-sm text-red-600">无法加载部署列表</div>
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
              <button onclick={() => mutateDeployment(dep.id, "redeploy")} disabled={pending.has(dep.id)} class="px-2.5 py-1 text-[10px] font-semibold rounded-md text-brand hover:bg-brand/10 transition-colors disabled:opacity-50">
                ↻ 重新部署
              </button>
              <button onclick={() => deleteDeployment(dep.id)} disabled={pending.has(dep.id)} class="px-2.5 py-1 text-[10px] font-semibold rounded-md text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50">
                {#if pending.get(dep.id) === "delete_deployment"}<Loader2 size={10} class="animate-spin inline" />{/if} 删除
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
