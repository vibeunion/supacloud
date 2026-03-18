<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, CheckCircle2, XCircle, Clock, GitCommit, RefreshCw } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);
  const deployId = $derived(page.url.pathname.split("/hosting/")[1]?.split("/")[0] || "");

  interface Record {
    id: string;
    status: string;
    commit_sha?: string;
    commit_message?: string;
    branch?: string;
    triggered_by: string;
    started_at: string;
    finished_at?: string;
    duration?: number;
  }

  let records: Record[] = $state([]);
  let isLoading = $state(true);

  async function fetchRecords() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/records`);
      if (res.ok) {
        const data = await res.json();
        records = data.records || [];
      }
    } catch {}
    isLoading = false;
  }

  onMount(() => fetchRecords());

  function triggerLabel(t: string): string {
    if (t === "webhook") return "🔗 Webhook";
    if (t === "ci") return "🤖 CI/CD";
    return "👤 手动";
  }

  function fmtDuration(ms?: number): string {
    if (!ms) return "-";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s/60)}m ${s%60}s`;
  }
</script>

<div class="space-y-4 max-w-3xl">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-bold">部署记录</h2>
      <p class="text-xs text-muted-foreground">ID: {deployId}</p>
    </div>
    <button onclick={() => fetchRecords()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
      <RefreshCw size={12} /> 刷新
    </button>
  </div>

  {#if isLoading}
    <div class="flex items-center justify-center py-16"><Loader2 size={24} class="animate-spin text-brand opacity-50" /></div>
  {:else if records.length === 0}
    <div class="p-8 text-center text-muted-foreground text-xs">暂无部署记录</div>
  {:else}
    <div class="space-y-2">
      {#each records as rec}
        <div class="rounded-xl border bg-card p-4 flex items-start gap-4 hover:border-brand/20 transition-all">
          <div class="mt-1">
            {#if rec.status === "success"}<CheckCircle2 size={20} class="text-green-500" />
            {:else if rec.status === "building" || rec.status === "pending"}<Loader2 size={20} class="text-amber-500 animate-spin" />
            {:else}<XCircle size={20} class="text-red-500" />{/if}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-bold">{rec.status === 'success' ? '部署成功' : rec.status === 'failed' ? '部署失败' : rec.status === 'building' ? '构建中...' : '等待中'}</span>
              <span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-muted text-muted-foreground">{triggerLabel(rec.triggered_by)}</span>
            </div>
            {#if rec.commit_sha}
              <div class="flex items-center gap-2 text-[10px] text-muted-foreground">
                <GitCommit size={10} />
                <span class="font-mono">{rec.commit_sha.slice(0, 7)}</span>
                {#if rec.commit_message}<span class="truncate max-w-64">— {rec.commit_message}</span>{/if}
                {#if rec.branch}<span class="px-1 py-0.5 rounded bg-brand/10 text-brand text-[9px]">{rec.branch}</span>{/if}
              </div>
            {/if}
            <div class="flex items-center gap-3 text-[10px] text-muted-foreground mt-1">
              <span class="flex items-center gap-1"><Clock size={10} /> {rec.started_at}</span>
              {#if rec.duration}<span>耗时: {fmtDuration(rec.duration)}</span>{/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
