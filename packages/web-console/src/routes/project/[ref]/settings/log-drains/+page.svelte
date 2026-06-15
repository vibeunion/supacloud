<script lang="ts">
  import { page } from "$app/state";
  import { Plus, Trash2, Send, Loader2, Save, Webhook } from "lucide-svelte";
  import { apiClient } from "$lib/api";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface LogDrain {
    id: string;
    name: string;
    type: string;
    url: string;
    has_token: boolean;
    enabled: boolean;
  }

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  let showAdd = $state(false);
  let msg = $state<string | null>(null);
  let errMsg = $state<string | null>(null);

  let newName = $state("");
  let newType = $state("webhook");
  let newUrl = $state("");
  let newToken = $state("");

  const DRAIN_TYPES = [
    { id: "webhook", label: "Webhook", icon: "🌐", desc: "发送日志到自定义 HTTP 端点" },
    { id: "datadog", label: "Datadog", icon: "🐕", desc: "发送到 Datadog Log Management" },
    { id: "loki", label: "Grafana Loki", icon: "📊", desc: "发送到 Grafana Loki 日志聚合服务" },
    { id: "elasticsearch", label: "Elasticsearch", icon: "🔍", desc: "发送到 Elasticsearch / OpenSearch" },
  ];

  const drainsQuery = createQuery(() => ({
    queryKey: ["log_drains", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/log-drains`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || "Failed to load log drains");
      return (data.drains || []) as LogDrain[];
    },
  }));

  const drains = $derived((drainsQuery.data as LogDrain[]) || []);
  const isLoading = $derived(drainsQuery.isPending);
  const loadError = $derived(drainsQuery.error?.message || null);

  const createDrainMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/log-drains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, type: newType, url: newUrl, token: newToken || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || "创建失败");
      return data;
    },
    onSuccess: () => {
      showAdd = false;
      newName = "";
      newUrl = "";
      newToken = "";
      msg = "✅ 日志转发目标已添加";
      setTimeout(() => (msg = null), 3000);
      queryClient.invalidateQueries({ queryKey: ["log_drains", projectRef] });
    },
    onError: (err: unknown) => {
      errMsg = (err instanceof Error ? err.message : String(err)) || "创建失败";
    },
  }));

  const toggleMutation = createMutation(() => ({
    mutationFn: async (drain: LogDrain) => {
      const res = await apiClient(`/v1/projects/${projectRef}/log-drains/${drain.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !drain.enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || "更新失败");
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["log_drains", projectRef] }),
    onError: (err: unknown) => {
      errMsg = (err instanceof Error ? err.message : String(err)) || "更新失败";
    },
  }));

  const deleteMutation = createMutation(() => ({
    mutationFn: async (drainId: string) => {
      const res = await apiClient(`/v1/projects/${projectRef}/log-drains/${drainId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || "删除失败");
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["log_drains", projectRef] }),
    onError: (err: unknown) => {
      errMsg = (err instanceof Error ? err.message : String(err)) || "删除失败";
    },
  }));

  function addDrain() {
    errMsg = null;
    if (!newName.trim() || !newUrl.trim()) {
      errMsg = "请填写名称和端点 URL";
      return;
    }
    createDrainMutation.mutate();
  }

  function removeDrain(id: string) {
    if (!confirm("确定删除此日志转发目标？")) return;
    deleteMutation.mutate(id);
  }

  function toggleDrain(drain: LogDrain) {
    toggleMutation.mutate(drain);
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">日志转发</h1>
      <p class="text-sm text-muted-foreground mt-1">将项目日志转发到外部日志服务进行聚合和分析</p>
    </div>
    <button
      onclick={() => (showAdd = !showAdd)}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
    >
      <Plus size={14} /> 添加目标
    </button>
  </div>

  {#if msg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium bg-green-500/5 border-green-500/20 text-green-700">{msg}</div>
  {/if}
  {#if errMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium bg-red-500/5 border-red-500/20 text-red-700">{errMsg}</div>
  {/if}

  {#if showAdd}
    <div class="rounded-xl border bg-card p-5 space-y-4">
      <h3 class="text-sm font-semibold">添加日志转发目标</h3>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <span class="text-xs text-muted-foreground">名称</span>
          <input
            type="text"
            bind:value={newName}
            placeholder="Production Logs"
            class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <div>
          <span class="text-xs text-muted-foreground">类型</span>
          <select
            bind:value={newType}
            class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          >
            {#each DRAIN_TYPES as dt (dt.id)}
              <option value={dt.id}>{dt.icon} {dt.label}</option>
            {/each}
          </select>
        </div>
      </div>
      <div>
        <span class="text-xs text-muted-foreground">端点 URL</span>
        <input
          type="url"
          bind:value={newUrl}
          placeholder="https://your-log-service.com/v1/logs"
          class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </div>
      <div>
        <span class="text-xs text-muted-foreground">认证 Token（可选）</span>
        <input
          type="password"
          bind:value={newToken}
          placeholder="Bearer token 或 API Key"
          class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </div>
      <div class="flex justify-end gap-2">
        <button onclick={() => (showAdd = false)} class="px-4 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">取消</button>
        <button
          onclick={addDrain}
          disabled={createDrainMutation.isPending}
          class="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          {#if createDrainMutation.isPending}<Loader2 size={12} class="animate-spin" />{:else}<Save size={12} />{/if}
          添加
        </button>
      </div>
    </div>
  {/if}

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Send size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">日志转发支持将 PostgreSQL 查询日志、Auth 事件、Storage Access 日志等实时推送到外部服务。支持 Webhook、Datadog、Grafana Loki、Elasticsearch 等目标。</p>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">加载中...</p>
      </div>
    {:else if loadError}
      <div class="p-4">
        <div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{loadError}</div>
      </div>
    {:else if drains.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Webhook size={40} class="opacity-20" />
        <p class="text-sm">暂无日志转发目标</p>
        <p class="text-xs">点击上方按钮添加第一个日志转发目标</p>
      </div>
    {:else}
      <div class="divide-y divide-border/20">
        {#each drains as drain (drain.id)}
          <div class="flex items-center justify-between px-5 py-4 hover:bg-muted/10 transition-colors group">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg flex items-center justify-center text-lg {drain.enabled ? 'bg-brand/10' : 'bg-muted/50'}">
                {DRAIN_TYPES.find((t) => t.id === drain.type)?.icon || '🌐'}
              </div>
              <div>
                <span class="font-semibold text-sm">{drain.name}</span>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase text-blue-600 bg-blue-500/10">{drain.type}</span>
                  <span class="text-[10px] text-muted-foreground font-mono truncate max-w-xs">{drain.url}</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button
                aria-label="Toggle"
                onclick={() => toggleDrain(drain)}
                class="relative w-10 h-5 rounded-full transition-colors {drain.enabled ? 'bg-brand' : 'bg-muted'}"
              >
                <span class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform {drain.enabled ? 'translate-x-5' : ''}"></span>
              </button>
              <button
                onclick={() => removeDrain(drain.id)}
                disabled={deleteMutation.isPending}
                class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded-md text-muted-foreground transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
