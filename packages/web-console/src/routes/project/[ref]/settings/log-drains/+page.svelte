<script lang="ts">
  import { page } from "$app/state";
  import { Plus, Trash2, Send, Database, Globe, AlertTriangle, Loader2, Save, Webhook } from "lucide-svelte";

  interface LogDrain {
    id: string;
    name: string;
    type: string;
    url: string;
    token: string;
    enabled: boolean;
  }

  let drains = $state<LogDrain[]>([]);
  let showAdd = $state(false);
  let saving = $state(false);
  let msg = $state<string | null>(null);

  let newName = $state("");
  let newType = $state("webhook");
  let newUrl = $state("");
  let newToken = $state("");

  const projectRef = $derived(page.params.ref);

  const DRAIN_TYPES = [
    { id: "webhook", label: "Webhook", icon: "🌐", desc: "发送日志到自定义 HTTP 端点" },
    { id: "datadog", label: "Datadog", icon: "🐕", desc: "发送到 Datadog Log Management" },
    { id: "loki", label: "Grafana Loki", icon: "📊", desc: "发送到 Grafana Loki 日志聚合服务" },
    { id: "elasticsearch", label: "Elasticsearch", icon: "🔍", desc: "发送到 Elasticsearch / OpenSearch" },
  ];

  function addDrain() {
    if (!newName.trim() || !newUrl.trim()) return;
    drains = [...drains, {
      id: crypto.randomUUID(),
      name: newName,
      type: newType,
      url: newUrl,
      token: newToken,
      enabled: true
    }];
    showAdd = false;
    newName = "";
    newUrl = "";
    newToken = "";
  }

  function removeDrain(id: string) {
    if (!confirm("确定删除此日志转发目标？")) return;
    drains = drains.filter(d => d.id !== id);
  }

  function toggleDrain(id: string) {
    drains = drains.map(d => d.id === id ? { ...d, enabled: !d.enabled } : d);
  }

  function saveDrains() {
    saving = true;
    setTimeout(() => {
      msg = "✅ 日志转发配置已保存";
      saving = false;
      setTimeout(() => msg = null, 3000);
    }, 500);
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">日志转发</h1>
      <p class="text-sm text-muted-foreground mt-1">将项目日志转发到外部日志服务进行聚合和分析</p>
    </div>
    <div class="flex gap-2">
      <button onclick={() => showAdd = !showAdd}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
        <Plus size={14} /> 添加目标
      </button>
      {#if drains.length > 0}
        <button onclick={saveDrains} disabled={saving}
          class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50">
          {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if} 保存
        </button>
      {/if}
    </div>
  </div>

  {#if msg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium bg-green-500/5 border-green-500/20 text-green-700">{msg}</div>
  {/if}

  {#if showAdd}
    <div class="rounded-xl border bg-card p-5 space-y-4">
      <h3 class="text-sm font-semibold">添加日志转发目标</h3>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <span class="text-xs text-muted-foreground">名称</span>
          <input type="text" bind:value={newName} placeholder="Production Logs"
            class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
        <div>
          <span class="text-xs text-muted-foreground">类型</span>
          <select bind:value={newType} class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand">
            {#each DRAIN_TYPES as dt}
              <option value={dt.id}>{dt.icon} {dt.label}</option>
            {/each}
          </select>
        </div>
      </div>
      <div>
        <span class="text-xs text-muted-foreground">端点 URL</span>
        <input type="url" bind:value={newUrl} placeholder="https://your-log-service.com/v1/logs"
          class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
      <div>
        <span class="text-xs text-muted-foreground">认证 Token（可选）</span>
        <input type="password" bind:value={newToken} placeholder="Bearer token 或 API Key"
          class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
      <div class="flex justify-end gap-2">
        <button onclick={() => showAdd = false} class="px-4 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">取消</button>
        <button onclick={addDrain} class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">添加</button>
      </div>
    </div>
  {/if}

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Send size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">日志转发支持将 PostgreSQL 查询日志、Auth 事件、Storage Access 日志等实时推送到外部服务。支持 Webhook、Datadog、Grafana Loki、Elasticsearch 等目标。</p>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if drains.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Webhook size={40} class="opacity-20" />
        <p class="text-sm">暂无日志转发目标</p>
        <p class="text-xs">点击上方按钮添加第一个日志转发目标</p>
      </div>
    {:else}
      <div class="divide-y divide-border/20">
        {#each drains as drain}
          <div class="flex items-center justify-between px-5 py-4 hover:bg-muted/10 transition-colors group">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg flex items-center justify-center text-lg {drain.enabled ? 'bg-brand/10' : 'bg-muted/50'}">
                {DRAIN_TYPES.find(t => t.id === drain.type)?.icon || '🌐'}
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
              <button onclick={() => toggleDrain(drain.id)}
                class="relative w-10 h-5 rounded-full transition-colors {drain.enabled ? 'bg-brand' : 'bg-muted'}">
                <span class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform {drain.enabled ? 'translate-x-5' : ''}"></span>
              </button>
              <button onclick={() => removeDrain(drain.id)}
                class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded-md text-muted-foreground transition-colors opacity-0 group-hover:opacity-100">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
