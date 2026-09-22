<script lang="ts">
  import { page } from "$app/state";
  import { onDestroy } from "svelte";
  import { Loader2, Database, Copy, RefreshCw, Settings } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import {
    loadProjectPoolingState,
    type ProjectPoolingState,
  } from "$lib/project-pooling";

  const projectRef = $derived(page.params.ref);

  let snapshot = $state<ProjectPoolingState | null>(null);
  let failed = $state(false);
  let isLoading = $state(false);
  let controller: AbortController | null = null;

  let scope = 0;
  let copying = $state(false);

  async function load(ref: string | undefined) {
    controller?.abort();
    const next = new AbortController();
    controller = next;
    if (!ref) {
      snapshot = null;
      failed = false;
      isLoading = false;
      return;
    }
    isLoading = true;
    failed = false;
    try {
      const result = await loadProjectPoolingState(ref, fetch, next.signal);
      if (next.signal.aborted) return;
      snapshot = result;
    } catch {
      if (next.signal.aborted) return;
      snapshot = null;
      failed = true;
    } finally {
      if (!next.signal.aborted) isLoading = false;
    }
  }

  $effect(() => {
    const ref = projectRef;
    scope += 1;
    copying = false;
    load(ref);
  });

  onDestroy(() => controller?.abort());

  const available = $derived(snapshot !== null && !failed);
  const connectionString = $derived(snapshot?.connectionString ?? "");
  const directString = $derived(snapshot?.directString ?? "");

  async function copy(kind: "pooler" | "direct") {
    const value = kind === "pooler" ? connectionString : directString;
    if (copying || !value) return;
    const started = scope;
    copying = true;
    try {
      await navigator.clipboard.writeText(value);
      if (scope === started) toast.success("连接字符串已复制");
    } catch {
      if (scope === started) toast.error("复制失败");
    } finally {
      if (scope === started) copying = false;
    }
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">连接池</h1>
      <p class="text-sm text-muted-foreground mt-1">通过 PgBouncer 管理数据库连接，减少连接开销</p>
    </div>
    <button
      title="刷新"
      onclick={() => load(projectRef)}
      disabled={!projectRef || isLoading}
      class="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50"
    >
      {#if isLoading}<Loader2 size={14} class="animate-spin" />{:else}<RefreshCw size={14} />{/if}
      刷新
    </button>
  </div>

  {#if failed}
    <div role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600">
      连接池配置暂不可用，请稍后重试。
    </div>
  {/if}

  {#if isLoading && !available}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if available}
    <!-- Connection Strings -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><Database size={18} /> 连接字符串</h2>
      </div>
      <div class="p-6 space-y-4">
        <div>
          <span class="text-xs font-semibold text-muted-foreground uppercase">Pooling 连接（推荐用于 Serverless）</span>
          <div class="flex items-center gap-2 mt-1">
            <div data-connection="pooler" class="flex-1 px-3 py-2 text-[11px] font-mono rounded-lg border bg-muted/30 text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
              {connectionString}
            </div>
            <button
              title="复制连接池地址"
              onclick={() => copy("pooler")}
              disabled={copying}
              class="px-3 py-2 rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <Copy size={14} />
            </button>
          </div>
        </div>
        <div>
          <span class="text-xs font-semibold text-muted-foreground uppercase">直连（Direct Connection）</span>
          <div class="flex items-center gap-2 mt-1">
            <div data-connection="direct" class="flex-1 px-3 py-2 text-[11px] font-mono rounded-lg border bg-muted/30 text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
              {directString}
            </div>
            <button
              title="复制直连地址"
              onclick={() => copy("direct")}
              disabled={copying}
              class="px-3 py-2 rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <Copy size={14} />
            </button>
          </div>
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
          <span class="font-medium text-sm">Pool 模式</span>
          <span data-setting="mode" class="font-mono text-sm">{snapshot?.poolMode ?? "未提供"}</span>
        </div>
        <div class="flex items-center justify-between px-6 py-4">
          <span class="font-medium text-sm">Pool 大小</span>
          <span data-setting="size" class="font-mono text-sm">{snapshot?.poolSize ?? "未提供"}</span>
        </div>
        <div class="flex items-center justify-between px-6 py-4">
          <span class="font-medium text-sm">PgBouncer 端口</span>
          <span class="font-mono text-sm">{snapshot?.poolerPort ?? "未提供"}</span>
        </div>
        <div class="flex items-center justify-between px-6 py-4">
          <span class="font-medium text-sm">直连端口</span>
          <span class="font-mono text-sm">{snapshot?.directPort ?? "未提供"}</span>
        </div>
      </div>
    </div>
  {/if}
</div>