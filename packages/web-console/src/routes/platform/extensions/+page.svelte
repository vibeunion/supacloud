<script lang="ts">
  import { onMount } from "svelte";
  import { Loader2, Package, Download, Trash2, RefreshCw, Search, AlertTriangle } from "lucide-svelte";

  interface SystemExt {
    name: string;
    version: string;
    status: string;
    description: string;
  }

  let extensions: SystemExt[] = $state([]);
  let isLoading = $state(true);
  let error: string | null = $state(null);
  let actionMsg: string | null = $state(null);
  let actionTarget: string | null = $state(null);
  let searchQuery = $state("");

  async function fetchExtensions() {
    isLoading = true;
    error = null;
    try {
      const res = await fetch("/v1/system/extensions");
      const data = await res.json();
      extensions = Array.isArray(data) ? data : [];
    } catch (err: any) {
      error = err.message;
    } finally {
      isLoading = false;
    }
  }

  async function installExt(name: string) {
    actionTarget = name;
    actionMsg = null;
    try {
      const res = await fetch("/v1/system/extensions/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      actionMsg = data.success ? `✅ ${data.message}` : `❌ ${data.message}`;
      if (data.success) await fetchExtensions();
    } catch (err: any) {
      actionMsg = `❌ ${err.message}`;
    } finally {
      actionTarget = null;
      setTimeout(() => actionMsg = null, 6000);
    }
  }

  async function removeExt(name: string) {
    if (!confirm(`确定要从系统中卸载扩展包 "${name}" 吗？这将影响所有使用该扩展的数据库。`)) return;
    actionTarget = name;
    actionMsg = null;
    try {
      const res = await fetch("/v1/system/extensions/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      actionMsg = data.success ? `✅ ${data.message}` : `❌ ${data.message}`;
      if (data.success) await fetchExtensions();
    } catch (err: any) {
      actionMsg = `❌ ${err.message}`;
    } finally {
      actionTarget = null;
      setTimeout(() => actionMsg = null, 6000);
    }
  }

  onMount(() => fetchExtensions());

  const filtered = $derived(
    searchQuery
      ? extensions.filter(e => e.name.toLowerCase().includes(searchQuery.toLowerCase()) || e.description.toLowerCase().includes(searchQuery.toLowerCase()))
      : extensions
  );

  // Popular extensions quick-install list
  const POPULAR = [
    { name: "pgvector", desc: "向量数据库扩展，AI/ML 嵌入搜索" },
    { name: "postgis", desc: "地理空间数据类型与查询" },
    { name: "timescaledb", desc: "时序数据库扩展" },
    { name: "pg_cron", desc: "数据库内置定时任务" },
    { name: "pg_stat_statements", desc: "查询性能统计" },
    { name: "pgrouting", desc: "地理路径分析" },
    { name: "pg_trgm", desc: "模糊文本搜索" },
    { name: "zhparser", desc: "中文全文检索分词" },
  ];
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">扩展市场 (Pigsty)</h2>
      <p class="text-xs text-muted-foreground mt-1">通过 <code class="px-1 py-0.5 rounded bg-muted text-[10px]">pig ext</code> 在操作系统层面安装/卸载 PostgreSQL 扩展包</p>
    </div>
    <button onclick={() => fetchExtensions()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
      <RefreshCw size={12} /> 刷新
    </button>
  </div>

  <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
    <p class="text-xs text-amber-700">系统级操作：安装/卸载扩展包会影响整个 PostgreSQL 实例。安装后需在项目的 <b>数据库 → 扩展</b> 页面中通过 <code>CREATE EXTENSION</code> 启用。</p>
  </div>

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  <!-- Popular Extensions Quick Install -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20">
      <h3 class="text-sm font-semibold">🔥 热门扩展快速安装</h3>
    </div>
    <div class="p-4 grid grid-cols-2 md:grid-cols-4 gap-2">
      {#each POPULAR as ext}
        <button
          onclick={() => installExt(ext.name)}
          disabled={actionTarget === ext.name}
          class="flex flex-col items-start gap-1 p-3 rounded-lg border hover:border-brand/40 hover:bg-brand/5 transition-all text-left disabled:opacity-50"
        >
          <div class="flex items-center gap-2">
            <Package size={14} class="text-brand" />
            <span class="text-xs font-bold">{ext.name}</span>
          </div>
          <span class="text-[10px] text-muted-foreground">{ext.desc}</span>
          {#if actionTarget === ext.name}
            <Loader2 size={12} class="animate-spin text-brand mt-1" />
          {:else}
            <span class="text-[9px] text-brand font-semibold mt-1 flex items-center gap-1"><Download size={10} /> 安装</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <!-- System Extensions List -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold">已安装的系统扩展包</h3>
      <div class="relative w-48">
        <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input bind:value={searchQuery} placeholder="搜索扩展..." class="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
    </div>

    {#if isLoading}
      <div class="flex items-center justify-center py-16">
        <Loader2 size={24} class="animate-spin text-brand opacity-50" />
      </div>
    {:else if error}
      <div class="p-4">
        <div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">{error}</div>
      </div>
    {:else if filtered.length === 0}
      <div class="p-8 text-center text-muted-foreground text-xs">
        {searchQuery ? '未找到匹配的扩展包' : '暂未通过 pig 安装任何系统级扩展。可使用上方热门列表快速安装。'}
      </div>
    {:else}
      <div class="overflow-auto max-h-96">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0 z-10">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">包名</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">版本</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">状态</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">描述</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each filtered as ext}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5 font-mono font-medium">{ext.name}</td>
                <td class="px-3 py-2.5 font-mono text-muted-foreground">{ext.version}</td>
                <td class="px-3 py-2.5">
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold {ext.status === 'installed' ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground'}">{ext.status}</span>
                </td>
                <td class="px-3 py-2.5 text-muted-foreground max-w-xs truncate">{ext.description}</td>
                <td class="px-4 py-2.5 text-right">
                  <button
                    onclick={() => removeExt(ext.name)}
                    disabled={actionTarget === ext.name}
                    class="px-2 py-1 text-[10px] rounded border border-red-500/20 text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-1 ml-auto disabled:opacity-50"
                  >
                    {#if actionTarget === ext.name}<Loader2 size={10} class="animate-spin" />{:else}<Trash2 size={10} />{/if} 卸载
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
