<script lang="ts">
  import { apiClient } from "$lib/api";
  import { requestValidatedJson } from "$lib/validated-json";
  import { ChevronLeft, ChevronRight, Database, RefreshCw } from "lucide-svelte";

  let { projectRef, openTable }: { projectRef: string; openTable: (sql: string, name: string) => void } = $props();
  type Table = { table_schema: string; table_name: string };
  let search = $state("");
  let offset = $state(0);
  let rows = $state<Table[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let error = $state("");
  let refresh = $state(0);
  const pageSize = 50;

  function decode(value: unknown): { data: Table[]; total: number } {
    if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)
      || !("total" in value) || typeof value.total !== "number" || !Number.isSafeInteger(value.total)
      || value.total < 0 || value.data.length > pageSize) throw new Error("表目录格式无效");
    return { total: value.total, data: value.data.map(item => {
      if (!item || typeof item !== "object" || typeof item.table_schema !== "string" || typeof item.table_name !== "string"
        || !item.table_schema || !item.table_name) throw new Error("表目录格式无效");
      return { table_schema: item.table_schema, table_name: item.table_name };
    }) };
  }
  $effect(() => {
    const ref = projectRef;
    const query = search;
    const skip = offset;
    refresh;
    const controller = new AbortController();
    loading = true;
    error = "";
    rows = [];
    const timer = setTimeout(() => {
      void requestValidatedJson(
        `/v1/projects/${encodeURIComponent(ref)}/database/tables?${new URLSearchParams({ limit: String(pageSize), skip: String(skip), q: query })}`,
        apiClient, decode, { signal: controller.signal }, { maxBytes: 128 * 1024 },
      ).then(result => {
        if (!controller.signal.aborted) { rows = result.data; total = result.total; }
      }).catch(() => {
        if (!controller.signal.aborted) error = "表目录暂不可用";
      }).finally(() => {
        if (!controller.signal.aborted) loading = false;
      });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  });
  function select(table: Table) {
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    openTable(`SELECT * FROM ${quote(table.table_schema)}.${quote(table.table_name)} LIMIT 100;`, table.table_name);
  }
</script>

<aside aria-label="数据库目录" class="flex flex-col border-r min-h-0 w-56 max-w-[40%] shrink-0">
  <div class="flex items-center justify-between border-b px-3 py-2 text-xs">
    <span class="flex items-center gap-2"><Database size={13} /> public</span>
    <button onclick={() => refresh += 1} disabled={loading} title="刷新表目录" aria-label="刷新表目录" class="p-1 disabled:opacity-50">
      <RefreshCw size={13} class={loading ? "animate-spin" : ""} />
    </button>
  </div>
  <input aria-label="搜索数据表" bind:value={search} oninput={() => offset = 0} placeholder="搜索数据表"
    class="m-2 min-w-0 rounded border bg-transparent px-2 py-1 text-xs" />
  <div class="flex-1 overflow-auto">
    {#if loading}<p role="status" class="px-3 py-2 text-xs text-muted-foreground">加载中...</p>
    {:else if error}<p role="alert" class="px-3 py-2 text-xs text-destructive">{error}</p>
    {:else if rows.length === 0}<p class="px-3 py-2 text-xs text-muted-foreground">没有匹配的数据表</p>
    {:else}
      {#each rows as row (`${row.table_schema}.${row.table_name}`)}
        <button onclick={() => select(row)} title={row.table_name}
          class="block w-full text-left px-3 py-2 text-xs truncate hover:bg-muted">{row.table_name}</button>
      {/each}
    {/if}
  </div>
  <div class="flex justify-between items-center border-t p-2 text-xs">
    <button disabled={loading || offset === 0} onclick={() => offset = Math.max(0, offset - pageSize)} title="上一页" aria-label="上一页" class="p-1 disabled:opacity-30"><ChevronLeft size={14} /></button>
    <span>{total} 张表</span>
    <button disabled={loading || offset + pageSize >= total} onclick={() => offset += pageSize} title="下一页" aria-label="下一页" class="p-1 disabled:opacity-30"><ChevronRight size={14} /></button>
  </div>
</aside>
