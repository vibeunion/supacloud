<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { page } from "$app/state";
  import { Database, Folder, Plus, Search, Trash2, ExternalLink, Loader2, X, Save } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  import { useList, type BaseRecord } from "@svadmin/core";

  interface Bucket extends BaseRecord {
    id?: string;
    name: string;
    public: boolean;
  }

  interface StorageFile extends BaseRecord {
    name: string;
    size: number;
    type: string;
    updated: string;
  }

  let selectedBucketId = $state<string | null>(null);

  // Create Bucket
  let showCreateBucket = $state(false);
  let newBucketName = $state("");
  let newBucketPublic = $state(false);
  let newBucketFileLimit = $state("50");
  let creatingBucket = $state(false);
  let bucketMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);

  const { query: bucketsQuery } = useList<Bucket>({ 
    get resource() { return `v1/storage/${projectRef}/buckets`; } 
  });
  const buckets = $derived(Array.isArray(bucketsQuery.data?.data) ? bucketsQuery.data.data : []);

  $effect(() => {
    if (buckets.length > 0 && !selectedBucketId) {
      selectedBucketId = String(buckets[0].id || buckets[0].name);
    }
  });

  const { query: filesQuery } = useList<StorageFile>({
    get resource() { return selectedBucketId ? `v1/storage/${projectRef}/buckets/${selectedBucketId}/files` : ""; },
    get queryOptions() { return { enabled: !!selectedBucketId }; }
  });
  const files = $derived(Array.isArray(filesQuery.data?.data) ? filesQuery.data.data : []);

  async function createBucket() {
    if (!newBucketName.trim()) { bucketMsg = "❌ 请输入 Bucket 名称"; setTimeout(() => bucketMsg = null, 3000); return; }
    creatingBucket = true;
    try {
      const res = await apiClient(`/v1/storage/${projectRef}/buckets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newBucketName.trim(),
          public: newBucketPublic,
          file_size_limit: parseInt(newBucketFileLimit) * 1024 * 1024, // MB to bytes
        })
      });
      if (res.ok) {
        bucketMsg = `✅ Bucket "${newBucketName}" 已创建`;
        showCreateBucket = false;
        newBucketName = "";
        newBucketPublic = false;
        bucketsQuery.refetch();
      } else {
        const err = await res.json();
        bucketMsg = `❌ 创建失败: ${err.error || (err instanceof Error ? err.message : String(err)) || res.statusText}`;
      }
    } catch (err: unknown) {
      bucketMsg = `❌ 创建失败: ${(err instanceof Error ? err.message : String(err))}`;
    } finally {
      creatingBucket = false;
      setTimeout(() => bucketMsg = null, 4000);
    }
  }



  let fileInput: HTMLInputElement;
  let isUploading = $state<boolean>(false);

  async function handleFileUpload(event: Event) {
    const target = event.target as HTMLInputElement;
    if (!target.files || target.files.length === 0 || !selectedBucketId) return;

    const file = target.files[0];
    isUploading = true;
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await apiClient(`/v1/storage/${projectRef}/buckets/${selectedBucketId}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(await res.text());
      
      // Refresh files list
      filesQuery.refetch();
    } catch (err: unknown) {
      toast.error("无法upload file");
      alert("上传失败");
    } finally {
      isUploading = false;
      target.value = ''; // Reset input
    }
  }

  async function deleteFile(fileName: string) {
    if (!selectedBucketId || !confirm(`确定删除 ${fileName} 吗？`)) return;
    
    try {
      const res = await apiClient(`/v1/storage/${projectRef}/buckets/${selectedBucketId}/files/${encodeURIComponent(fileName)}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error(await res.text());
      
      filesQuery.refetch();
    } catch (err: unknown) {
      toast.error("无法delete file");
      alert("删除失败");
    }
  }


</script>

<div class="h-full flex flex-col -m-4 sm:-m-6 lg:-m-8">
  <div class="flex-1 flex overflow-hidden">
    <!-- Buckets Sidebar -->
    <aside class="w-64 border-r bg-muted/20 flex flex-col">
      <div class="p-4 border-b flex items-center justify-between bg-muted/30">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{$t("Storage.buckets")}</h2>
        <button onclick={() => showCreateBucket = !showCreateBucket} class="p-1 hover:bg-muted rounded transition-colors" title={$t("Storage.new_bucket")}>
          <Plus size={16} class="text-brand" />
        </button>
      </div>

      {#if showCreateBucket}
        <div class="p-3 border-b bg-brand/5 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-[10px] font-bold text-brand uppercase">新建 Bucket</span>
            <button onclick={() => showCreateBucket = false} class="text-muted-foreground hover:text-foreground"><X size={12} /></button>
          </div>
          <input type="text" bind:value={newBucketName} placeholder="bucket-name"
            class="w-full px-2 py-1.5 text-xs font-mono rounded border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
          <div class="flex items-center justify-between">
            <label class="flex items-center gap-1.5 text-[10px] cursor-pointer">
              <input type="checkbox" bind:checked={newBucketPublic} class="rounded" /> 公开访问
            </label>
            <div class="flex items-center gap-1">
              <input type="number" bind:value={newBucketFileLimit} min="1" max="500"
                class="w-12 px-1 py-0.5 text-[10px] font-mono text-center rounded border bg-background focus:outline-none" />
              <span class="text-[9px] text-muted-foreground">MB</span>
            </div>
          </div>
          <button onclick={createBucket} disabled={creatingBucket}
            class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
            {#if creatingBucket}<Loader2 size={10} class="animate-spin" />{:else}<Save size={10} />{/if} 创建
          </button>
          {#if bucketMsg}
            <div class="text-[10px] {bucketMsg.startsWith('✅') ? 'text-green-700' : 'text-red-600'}">{bucketMsg}</div>
          {/if}
        </div>
      {/if}
      
      <div class="flex-1 overflow-y-auto p-2 space-y-1">
        {#if bucketsQuery.isLoading}
          <div class="flex flex-col items-center justify-center py-12 gap-2 opacity-50">
            <Loader2 size={16} class="animate-spin text-brand" />
            <span class="text-[10px] uppercase tracking-tighter">{$t("Storage.scanning")}</span>
          </div>
        {:else}
          {#each buckets as bucket}
            <button 
              onclick={() => selectedBucketId = String(bucket.id || bucket.name)}
              class="w-full flex items-center justify-between px-3 py-2 text-sm rounded-md transition-all
                {selectedBucketId === (bucket.id || bucket.name) ? 'bg-brand/10 text-brand font-medium' : 'hover:bg-muted/50 text-foreground'}"
            >
              <div class="flex items-center gap-2">
                <Database size={14} class={selectedBucketId === (bucket.id || bucket.name) ? 'text-brand' : 'text-muted-foreground'} />
                <span>{bucket.name}</span>
              </div>
              {#if bucket.public}
                <span class="text-[9px] px-1.5 py-0.5 bg-green-500/10 text-green-600 rounded">{$t("Storage.public")}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </aside>

    <!-- Files Container -->
    <main class="flex-1 flex flex-col bg-background">
      <!-- Toolbar -->
      <header class="h-14 border-b px-6 flex items-center justify-between bg-background/50 backdrop-blur">
        <div class="flex items-center gap-4">
          <div class="flex items-center text-sm text-muted-foreground italic">
            <Folder size={14} class="mr-2" />
            <span>storage / {selectedBucketId}</span>
          </div>
        </div>
        
        <div class="flex items-center gap-2">
          <div class="relative group">
            <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-brand transition-colors" />
            <input 
              type="text" 
              placeholder={$t("Storage.search_files")} 
              class="pl-9 pr-4 py-1.5 bg-muted/40 border-none rounded-full text-xs focus:ring-1 focus:ring-brand w-48 transition-all"
            />
          </div>
          <button 
            onclick={() => fileInput.click()}
            disabled={isUploading || !selectedBucketId}
            class="flex items-center gap-2 px-4 py-1.5 bg-brand text-white text-xs font-semibold rounded-full shadow-lg shadow-brand/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:hover:scale-100"
          >
            {#if isUploading}
              <Loader2 size={14} class="animate-spin" />
              <span>Uploading...</span>
            {:else}
              <Plus size={14} />
              <span>{$t("Storage.upload_file")}</span>
            {/if}
          </button>
          <input 
            type="file" 
            bind:this={fileInput} 
            onchange={handleFileUpload} 
            class="hidden" 
          />
        </div>
      </header>

      <!-- Files Table -->
      <div class="flex-1 overflow-y-auto p-6">
        <div class="rounded-xl border border-border/50 shadow-sm overflow-hidden bg-background">
          {#if filesQuery.isLoading || (selectedBucketId && !filesQuery.isSuccess && !filesQuery.isError)}
            <div class="py-24 flex flex-col items-center justify-center text-muted-foreground gap-3">
              <Loader2 size={32} class="animate-spin text-brand opacity-50" />
              <p class="text-xs font-mono uppercase tracking-widest">{$t("Storage.hydrating_streams")}</p>
            </div>
          {:else}
            <table class="w-full text-left text-sm">
              <thead class="bg-muted/10">
                <tr>
                  <th class="px-6 py-4 font-medium text-muted-foreground">{$t("Storage.name")}</th>
                  <th class="px-6 py-4 font-medium text-muted-foreground text-right">{$t("Storage.size")}</th>
                  <th class="px-6 py-4 font-medium text-muted-foreground">{$t("Storage.type")}</th>
                  <th class="px-6 py-4 font-medium text-muted-foreground">{$t("Storage.last_modified")}</th>
                  <th class="px-6 py-4"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border/50">
                {#each files as file}
                  <tr class="hover:bg-muted/10 group transition-colors">
                    <td class="px-6 py-4">
                      <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded flex items-center justify-center bg-brand/5 text-brand">
                          <Folder size={16} />
                        </div>
                        <span class="font-medium group-hover:text-brand transition-colors cursor-pointer">{file.name}</span>
                      </div>
                    </td>
                    <td class="px-6 py-4 text-right text-muted-foreground tabular-nums">{file.size}</td>
                    <td class="px-6 py-4">
                      <span class="text-xs px-2 py-0.5 bg-muted rounded text-muted-foreground">{file.type}</span>
                    </td>
                    <td class="px-6 py-4 text-muted-foreground tabular-nums">{new Date(String(file.updated)).toLocaleString()}</td>
                    <td class="px-6 py-4 text-right">
                      <button 
                        onclick={() => deleteFile(String(file.name))}
                        class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded text-muted-foreground transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete file"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
            
            {#if files.length === 0}
              <div class="py-24 flex flex-col items-center justify-center text-muted-foreground">
                <Folder size={48} class="mb-4 opacity-20" />
                <p>{$t("Storage.no_files")}</p>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </main>
  </div>
</div>
