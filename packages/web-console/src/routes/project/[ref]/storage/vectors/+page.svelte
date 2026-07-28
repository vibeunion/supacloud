<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { apiClient } from "$lib/api";
  import { Braces, Database, Loader2, Plus, Search, Trash2 } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { onMount } from "svelte";

  type VectorBucket = { vectorBucketName: string; creationTime?: number };
  type VectorIndex = {
    vectorBucketName: string;
    indexName: string;
    creationTime?: number;
    dimension?: number;
    distanceMetric?: "cosine" | "euclidean";
  };
  type QueryResult = { vectors: Array<{ key: string; distance?: number; metadata?: Record<string, unknown> }> };

  const projectRef = $derived(page.params.ref!);
  let buckets = $state<VectorBucket[]>([]);
  let indexes = $state<VectorIndex[]>([]);
  let selectedBucket = $state("");
  let selectedIndex = $state("");
  let loading = $state(false);
  let newBucketName = $state("");
  let newIndexName = $state("");
  let newIndexDimension = $state(1536);
  let newIndexMetric = $state<"cosine" | "euclidean">("cosine");
  let queryVectorText = $state("[0.1, 0.2, 0.3]");
  let queryTopK = $state(10);
  let queryResult = $state<QueryResult | null>(null);

  async function vectorRequest<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    const response = await apiClient(
      `/v1/projects/${encodeURIComponent(projectRef)}/storage/vector/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
      throw new Error(payload.message || payload.error || response.statusText);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) return undefined as T;
    return await response.json() as T;
  }

  async function loadBuckets() {
    loading = true;
    try {
      const payload = await vectorRequest<{ vectorBuckets: VectorBucket[] }>("ListVectorBuckets", {});
      buckets = payload.vectorBuckets || [];
      if (!selectedBucket || !buckets.some((bucket) => bucket.vectorBucketName === selectedBucket)) {
        selectedBucket = buckets[0]?.vectorBucketName || "";
      }
      await loadIndexes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载 Vector Buckets 失败");
    } finally {
      loading = false;
    }
  }

  async function loadIndexes() {
    if (!selectedBucket) {
      indexes = [];
      selectedIndex = "";
      return;
    }
    const payload = await vectorRequest<{ indexes: VectorIndex[] }>("ListIndexes", {
      vectorBucketName: selectedBucket,
    });
    indexes = payload.indexes || [];
    if (!selectedIndex || !indexes.some((index) => index.indexName === selectedIndex)) {
      selectedIndex = indexes[0]?.indexName || "";
    }
  }

  async function createBucket() {
    if (!newBucketName.trim()) return;
    try {
      await vectorRequest("CreateVectorBucket", { vectorBucketName: newBucketName.trim() });
      selectedBucket = newBucketName.trim();
      newBucketName = "";
      await loadBuckets();
      toast.success("Vector Bucket 已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建失败");
    }
  }

  async function deleteBucket(name: string) {
    if (!confirm(`删除 Vector Bucket “${name}”？桶中存在索引时将拒绝删除。`)) return;
    try {
      await vectorRequest("DeleteVectorBucket", { vectorBucketName: name });
      await loadBuckets();
      toast.success("Vector Bucket 已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function createIndex() {
    if (!selectedBucket || !newIndexName.trim()) return;
    try {
      await vectorRequest("CreateIndex", {
        vectorBucketName: selectedBucket,
        indexName: newIndexName.trim(),
        dataType: "float32",
        dimension: newIndexDimension,
        distanceMetric: newIndexMetric,
      });
      selectedIndex = newIndexName.trim();
      newIndexName = "";
      await loadIndexes();
      toast.success("Vector Index 已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建索引失败");
    }
  }

  async function deleteIndex(name: string) {
    if (!confirm(`删除 Vector Index “${name}”及其中全部向量？`)) return;
    try {
      await vectorRequest("DeleteIndex", { vectorBucketName: selectedBucket, indexName: name });
      await loadIndexes();
      toast.success("Vector Index 已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除索引失败");
    }
  }

  async function queryVectors() {
    if (!selectedBucket || !selectedIndex) return;
    try {
      const values = JSON.parse(queryVectorText) as unknown;
      if (!Array.isArray(values) || values.some((value) => typeof value !== "number")) {
        throw new Error("查询向量必须是数字数组");
      }
      queryResult = await vectorRequest<QueryResult>("QueryVectors", {
        vectorBucketName: selectedBucket,
        indexName: selectedIndex,
        queryVector: { float32: values },
        topK: queryTopK,
        returnDistance: true,
        returnMetadata: true,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "查询失败");
    }
  }

  onMount(() => {
    void loadBuckets();
  });
</script>

<svelte:head><title>Vector Buckets · SupaCloud</title></svelte:head>

<div class="space-y-6">
  <header class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">Vector Buckets</h1>
      <p class="mt-1 text-sm text-muted-foreground">Supabase Storage Vectors 兼容的向量桶、索引与相似度查询。</p>
    </div>
    <a href={resolve(`/project/${projectRef}/storage`)} class="rounded-lg border px-3 py-2 text-sm hover:bg-muted">返回文件存储</a>
  </header>

  <div class="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
    <section class="rounded-xl border bg-card">
      <div class="flex items-center justify-between border-b p-4">
        <div class="flex items-center gap-2 font-semibold"><Database size={16} />Buckets</div>
        {#if loading}<Loader2 size={15} class="animate-spin text-muted-foreground" />{/if}
      </div>
      <div class="space-y-2 border-b p-3">
        <input bind:value={newBucketName} placeholder="embeddings" class="w-full rounded-lg border bg-background px-3 py-2 text-sm font-mono" />
        <button onclick={createBucket} class="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!newBucketName.trim()}>
          <Plus size={14} />创建 Vector Bucket
        </button>
      </div>
      <div class="p-2">
        {#if buckets.length === 0 && !loading}
          <p class="p-4 text-center text-sm text-muted-foreground">暂无 Vector Bucket</p>
        {/if}
        {#each buckets as bucket (bucket.vectorBucketName)}
          <div class="group flex items-center rounded-lg {selectedBucket === bucket.vectorBucketName ? 'bg-brand/10 text-brand' : 'hover:bg-muted'}">
            <button class="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm font-mono" onclick={async () => { selectedBucket = bucket.vectorBucketName; await loadIndexes(); }}>
              {bucket.vectorBucketName}
            </button>
            <button class="p-2 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" onclick={() => deleteBucket(bucket.vectorBucketName)} title="删除桶"><Trash2 size={14} /></button>
          </div>
        {/each}
      </div>
    </section>

    <div class="space-y-6">
      <section class="rounded-xl border bg-card">
        <div class="border-b p-4">
          <h2 class="font-semibold">Indexes {#if selectedBucket}<span class="font-mono text-sm text-muted-foreground">/ {selectedBucket}</span>{/if}</h2>
        </div>
        <div class="grid gap-3 border-b p-4 md:grid-cols-[minmax(0,1fr)_140px_140px_auto]">
          <input bind:value={newIndexName} placeholder="documents-openai" class="rounded-lg border bg-background px-3 py-2 text-sm font-mono" />
          <input bind:value={newIndexDimension} type="number" min="1" max="4096" class="rounded-lg border bg-background px-3 py-2 text-sm" aria-label="Dimension" />
          <select bind:value={newIndexMetric} class="rounded-lg border bg-background px-3 py-2 text-sm">
            <option value="cosine">cosine</option>
            <option value="euclidean">euclidean</option>
          </select>
          <button onclick={createIndex} disabled={!selectedBucket || !newIndexName.trim()} class="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">创建索引</button>
        </div>
        <div class="divide-y">
          {#if indexes.length === 0}<p class="p-6 text-center text-sm text-muted-foreground">请选择桶并创建索引</p>{/if}
          {#each indexes as index (index.indexName)}
            <div class="flex items-center gap-3 p-4 {selectedIndex === index.indexName ? 'bg-brand/5' : ''}">
              <button class="min-w-0 flex-1 text-left" onclick={() => selectedIndex = index.indexName}>
                <div class="font-mono text-sm font-medium">{index.indexName}</div>
                <div class="mt-1 text-xs text-muted-foreground">点击后用于向量查询</div>
              </button>
              <button class="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onclick={() => deleteIndex(index.indexName)} title="删除索引"><Trash2 size={15} /></button>
            </div>
          {/each}
        </div>
      </section>

      <section class="rounded-xl border bg-card">
        <div class="flex items-center gap-2 border-b p-4 font-semibold"><Search size={16} />Query Vectors</div>
        <div class="space-y-4 p-4">
          <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px_auto]">
            <textarea bind:value={queryVectorText} rows="3" class="rounded-lg border bg-background px-3 py-2 font-mono text-sm" placeholder="[0.1, 0.2, 0.3]"></textarea>
            <input bind:value={queryTopK} type="number" min="1" max="100" class="h-10 rounded-lg border bg-background px-3 text-sm" aria-label="Top K" />
            <button onclick={queryVectors} disabled={!selectedIndex} class="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-white disabled:opacity-50">查询</button>
          </div>
          {#if queryResult}
            <div class="rounded-lg border bg-muted/30 p-4">
              <div class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"><Braces size={14} />{queryResult.vectors.length} results</div>
              <pre class="overflow-auto text-xs">{JSON.stringify(queryResult, null, 2)}</pre>
            </div>
          {/if}
        </div>
      </section>
    </div>
  </div>
</div>
