<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, Database, Copy, RefreshCw, Settings } from "lucide-svelte";

  let poolMode = $state("transaction");
  let poolSize = $state(15);
  let pgbouncerPort = $state(6543);
  let isLoading = $state(true);

  const projectRef = $derived(page.params.ref);
  const hostname = $derived(page.url?.hostname || "localhost");

  const connectionString = $derived(
    `postgres://postgres.[PROJECT_REF]:${pgbouncerPort !== 5432 ? `[YOUR-PASSWORD]@${hostname}:${pgbouncerPort}` : `[YOUR-PASSWORD]@${hostname}`}/postgres?pgbouncer=true`
  );

  const directString = $derived(
    `postgres://postgres:[YOUR-PASSWORD]@${hostname}:5432/postgres`
  );

  async function fetchPooling() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}`);
      if (res.ok) {
        const data = await res.json();
        const cfg = data.config || {};
        poolMode = cfg.pgbouncer_pool_mode || "transaction";
        poolSize = cfg.pgbouncer_default_pool_size || 15;
        pgbouncerPort = cfg.pgbouncer_port || 6543;
      }
    } catch (err) {
      console.error("Failed to fetch pooling config:", err);
    } finally {
      isLoading = false;
    }
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  onMount(() => { fetchPooling(); });
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">连接池</h1>
    <p class="text-sm text-muted-foreground mt-1">通过 PgBouncer 管理数据库连接，减少连接开销</p>
  </div>

  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- Connection Strings -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><Database size={18} /> 连接字符串</h2>
      </div>
      <div class="p-6 space-y-4">
        <div>
          <span class="text-xs font-semibold text-muted-foreground uppercase">Pooling 连接（推荐用于 Serverless）</span>
          <div class="flex items-center gap-2 mt-1">
            <div class="flex-1 px-3 py-2 text-[11px] font-mono rounded-lg border bg-muted/30 text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
              {connectionString}
            </div>
            <button onclick={() => copyText(connectionString)} class="px-3 py-2 rounded-lg border hover:bg-muted/50 transition-colors">
              <Copy size={14} />
            </button>
          </div>
          <p class="text-[10px] text-muted-foreground mt-1">端口 {pgbouncerPort} · {poolMode} 模式 · 适合短连接/Serverless 场景</p>
        </div>
        <div>
          <span class="text-xs font-semibold text-muted-foreground uppercase">直连（Direct Connection）</span>
          <div class="flex items-center gap-2 mt-1">
            <div class="flex-1 px-3 py-2 text-[11px] font-mono rounded-lg border bg-muted/30 text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
              {directString}
            </div>
            <button onclick={() => copyText(directString)} class="px-3 py-2 rounded-lg border hover:bg-muted/50 transition-colors">
              <Copy size={14} />
            </button>
          </div>
          <p class="text-[10px] text-muted-foreground mt-1">端口 5432 · 直连 PostgreSQL · 适合迁移、管理工具</p>
        </div>
      </div>
    </div>

    <!-- Pool Config -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><Settings size={18} /> 连接池配置</h2>
      </div>
      <div class="divide-y divide-border/20">
        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <span class="font-medium text-sm">Pool 模式</span>
            <p class="text-[10px] text-muted-foreground mt-0.5">Transaction：每次事务结束后归还连接 · Session：会话期间独占连接</p>
          </div>
          <div class="flex gap-1 bg-muted/30 rounded-lg p-0.5">
            <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors {poolMode === 'transaction' ? 'bg-brand text-white' : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => poolMode = 'transaction'}>Transaction</button>
            <button class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors {poolMode === 'session' ? 'bg-brand text-white' : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => poolMode = 'session'}>Session</button>
          </div>
        </div>
        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <span class="font-medium text-sm">Pool 大小</span>
            <p class="text-[10px] text-muted-foreground mt-0.5">每个 PostgreSQL 用户的最大连接数</p>
          </div>
          <span class="px-3 py-1 rounded-lg bg-brand/10 text-brand font-mono text-sm font-bold">{poolSize}</span>
        </div>
        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <span class="font-medium text-sm">PgBouncer 端口</span>
            <p class="text-[10px] text-muted-foreground mt-0.5">连接池代理监听端口</p>
          </div>
          <span class="px-3 py-1 rounded-lg bg-brand/10 text-brand font-mono text-sm font-bold">{pgbouncerPort}</span>
        </div>
      </div>
    </div>

    <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
      <RefreshCw size={14} class="text-blue-600 mt-0.5 shrink-0" />
      <p class="text-xs text-blue-700"><b>Transaction 模式</b>适合大多数 Serverless（如 Vercel Edge Functions、Cloudflare Workers）场景。每次查询/事务结束后连接会被归还到池中供其他请求使用，大大减少了实际需要的 PostgreSQL 后端连接数。</p>
    </div>
  {/if}
</div>
