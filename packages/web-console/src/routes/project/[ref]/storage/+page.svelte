<script lang="ts">
  import { apiClient } from "$lib/api";
  import { resolve } from "$app/paths";

  import { t } from "svelte-i18n";
  import { page } from "$app/state";
  import { BrainCircuit, Copy, Database, Download, Eye, Folder, Loader2, Plus, Save, Search, Trash2, X } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createMutation } from "@tanstack/svelte-query";
  import { useList, type BaseRecord } from "@svadmin/core";

  interface Bucket extends BaseRecord {
    id?: string;
    name: string;
    public: boolean;
  }

  interface StorageFile extends BaseRecord {
    name: string;
    size: number | string;
    type: string;
    updated: string;
  }

  let selectedBucketId = $state<string | null>(null);
  let fileSearch = $state("");

  let showCreateBucket = $state(false);
  let newBucketName = $state("");
  let newBucketPublic = $state(false);
  let newBucketFileLimit = $state("50");
  let bucketMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref!);

  const bucketsQuery = useList<Bucket>({ 
    get resource() { return `v1/storage/${projectRef}/buckets`; } 
  });
  const buckets = $derived(Array.isArray(bucketsQuery.data?.data) ? bucketsQuery.data.data : []);

  $effect(() => {
    if (buckets.length > 0 && !selectedBucketId) {
      selectedBucketId = String(buckets[0].id || buckets[0].name);
    }
  });

  const filesQuery = useList<StorageFile>({
    get resource() { return selectedBucketId ? `v1/storage/${projectRef}/buckets/${selectedBucketId}/files` : ""; },
    get queryOptions() { return { enabled: !!selectedBucketId }; }
  });
  const files = $derived(Array.isArray(filesQuery.data?.data) ? filesQuery.data.data : []);
  const visibleFiles = $derived(files.filter((file) => file.name.toLowerCase().includes(fileSearch.trim().toLowerCase())));

  function bucketDisplayName(bucketName: string): string {
    return bucketName === "bucket" ? $t("Storage.default_bucket") : bucketName;
  }

  async function readJsonResponse<T>(response: Response): Promise<T> {
    if (!response.ok) throw new Error(await responseErrorMessage(response));
    return await response.json() as T;
  }

  async function responseErrorMessage(response: Response): Promise<string> {
    const payload = await response.json() as { error?: string; message?: string };
    return payload.message || payload.error || response.statusText;
  }

  function fileContentUrl(fileName: string): string {
    const bucketId = encodeURIComponent(selectedBucketId!);
    return `/v1/storage/${encodeURIComponent(projectRef)}/buckets/${bucketId}/files/content?path=${encodeURIComponent(fileName)}`;
  }

  function filePublicUrlEndpoint(fileName: string): string {
    const bucketId = encodeURIComponent(selectedBucketId!);
    return `/v1/storage/${encodeURIComponent(projectRef)}/buckets/${bucketId}/files/public-url?path=${encodeURIComponent(fileName)}`;
  }

  const createBucketMutation = createMutation(() => ({
    mutationFn: async () => {
      const response = await apiClient(`/v1/storage/${projectRef}/buckets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newBucketName.trim(),
          public: newBucketPublic,
          file_size_limit: parseInt(newBucketFileLimit) * 1024 * 1024,
        })
      });
      return readJsonResponse(response);
    },
    onSuccess: () => {
      bucketMsg = `✅ ${$t("Storage.bucket_created", { values: { name: newBucketName } })}`;
      showCreateBucket = false;
      newBucketName = "";
      newBucketPublic = false;
      bucketsQuery.refetch();
      setTimeout(() => bucketMsg = null, 4000);
    },
    onError: (error: unknown) => {
      bucketMsg = `❌ ${error instanceof Error ? error.message : $t("Storage.create_bucket_failed")}`;
      setTimeout(() => bucketMsg = null, 4000);
    }
  }));

  function createBucket() {
    if (!newBucketName.trim()) {
      bucketMsg = `❌ ${$t("Storage.bucket_name_required")}`;
      setTimeout(() => bucketMsg = null, 3000);
      return;
    }
    bucketMsg = null;
    createBucketMutation.mutate();
  }

  let fileInput: HTMLInputElement;

  const uploadMutation = createMutation(() => ({
    mutationFn: async ({ file, target }: { file: File, target: HTMLInputElement }) => {
      const formData = new FormData();
      formData.append("file", file);

      const response = await apiClient(`/v1/storage/${projectRef}/buckets/${selectedBucketId}/upload`, {
        method: "POST",
        body: formData,
      });

      return readJsonResponse(response);
    },
    onSuccess: () => {
      filesQuery.refetch();
      toast.success($t("Storage.upload_succeeded"));
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : $t("Storage.upload_failed"));
    },
    onSettled: (_payload, _error, variables) => {
      variables.target.value = '';
    }
  }));

  function handleFileUpload(event: Event) {
    const target = event.target as HTMLInputElement;
    if (!target.files || target.files.length === 0 || !selectedBucketId) return;

    const file = target.files[0];
    if (files.some((existingFile) => existingFile.name === file.name)) {
      toast.error($t("Storage.file_already_exists", { values: { name: file.name } }));
      target.value = "";
      return;
    }
    uploadMutation.mutate({ file, target });
  }

  const deleteBucketMutation = createMutation(() => ({
    mutationFn: async (bucketId: string) => {
      const response = await apiClient(`/v1/projects/${encodeURIComponent(projectRef)}/storage/buckets/${encodeURIComponent(bucketId)}`, {
        method: "DELETE",
      });
      return readJsonResponse(response);
    },
    onSuccess: (_payload, deletedBucketId) => {
      if (selectedBucketId === deletedBucketId) {
        const nextBucket = buckets.find((bucket) => String(bucket.id || bucket.name) !== deletedBucketId);
        selectedBucketId = nextBucket ? String(nextBucket.id || nextBucket.name) : null;
      }
      bucketsQuery.refetch();
      toast.success($t("Storage.bucket_deleted"));
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : $t("Storage.delete_bucket_failed"));
    },
  }));

  function deleteBucket(bucket: Bucket) {
    const bucketId = String(bucket.id || bucket.name);
    if (!confirm($t("Storage.delete_bucket_confirm", { values: { name: bucket.name } }))) return;
    deleteBucketMutation.mutate(bucketId);
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async (fileName: string) => {
      const response = await apiClient(fileContentUrl(fileName), {
        method: "DELETE"
      });
      return readJsonResponse(response);
    },
    onSuccess: () => {
      filesQuery.refetch();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : $t("Storage.delete_file_failed"));
    }
  }));

  function deleteFile(fileName: string) {
    if (!selectedBucketId || !confirm($t("Storage.delete_file_confirm", { values: { name: fileName } }))) return;
    deleteMutation.mutate(fileName);
  }

  const downloadMutation = createMutation(() => ({
    mutationFn: async (fileName: string) => {
      const response = await apiClient(fileContentUrl(fileName));
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      return { blob: await response.blob(), fileName };
    },
    onSuccess: ({ blob, fileName }) => {
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName.split("/").pop() || fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : $t("Storage.download_failed"));
    },
  }));

  const copyPublicUrlMutation = createMutation(() => ({
    mutationFn: async (fileName: string) => {
      const response = await apiClient(filePublicUrlEndpoint(fileName));
      if (response.status === 409) throw new Error($t("Storage.public_url_requires_public_bucket"));
      const payload = await readJsonResponse<{ public_url: string }>(response);
      await navigator.clipboard.writeText(payload.public_url);
    },
    onSuccess: () => toast.success($t("Storage.public_url_copied")),
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : $t("Storage.copy_public_url_failed"));
    },
  }));

  function previewFile(fileName: string) {
    window.open(fileContentUrl(fileName), "_blank", "noopener,noreferrer");
  }

</script>

<div class="h-full flex flex-col -m-4 sm:-m-6 lg:-m-8">
  <div class="flex-1 flex overflow-hidden">
    <!-- Buckets Sidebar -->
    <aside class="w-64 border-r bg-muted/20 flex flex-col">
      <div class="p-4 border-b flex items-center justify-between bg-muted/30">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{$t("Storage.buckets")}</h2>
        <div class="flex items-center gap-1">
          <a href={resolve(`/project/${projectRef}/storage/vectors`)} class="p-1 hover:bg-muted rounded transition-colors" title="Vector Buckets"><BrainCircuit size={16} class="text-brand" /></a>
          <button onclick={() => showCreateBucket = !showCreateBucket} class="p-1 hover:bg-muted rounded transition-colors" title={$t("Storage.new_bucket")}>
            <Plus size={16} class="text-brand" />
          </button>
        </div>
      </div>

      {#if showCreateBucket}
        <div class="p-3 border-b bg-brand/5 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-[10px] font-bold text-brand uppercase">{$t("Storage.new_bucket")}</span>
            <button onclick={() => showCreateBucket = false} class="text-muted-foreground hover:text-foreground"><X size={12} /></button>
          </div>
          <input type="text" bind:value={newBucketName} placeholder="bucket-name"
            class="w-full px-2 py-1.5 text-xs font-mono rounded border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
          <div class="flex items-center justify-between">
            <label class="flex items-center gap-1.5 text-[10px] cursor-pointer">
              <input type="checkbox" bind:checked={newBucketPublic} class="rounded" /> {$t("Storage.public_access")}
            </label>
            <div class="flex items-center gap-1">
              <input type="number" bind:value={newBucketFileLimit} min="1" max="500"
                class="w-12 px-1 py-0.5 text-[10px] font-mono text-center rounded border bg-background focus:outline-none" />
              <span class="text-[9px] text-muted-foreground">MB</span>
            </div>
          </div>
          <button onclick={createBucket} disabled={createBucketMutation.isPending}
            class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
            {#if createBucketMutation.isPending}<Loader2 size={10} class="animate-spin" />{:else}<Save size={10} />{/if} {$t("Storage.create")}
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
          {#each buckets as bucket (bucket.id || bucket.name)}
            <div class="group flex items-center rounded-md transition-all
              {selectedBucketId === String(bucket.id || bucket.name) ? 'bg-brand/10 text-brand font-medium' : 'hover:bg-muted/50 text-foreground'}">
              <button
                onclick={() => selectedBucketId = String(bucket.id || bucket.name)}
                class="min-w-0 flex-1 flex items-center justify-between px-3 py-2 text-sm"
              >
                <span class="min-w-0 flex items-center gap-2">
                  <Database size={14} class={selectedBucketId === String(bucket.id || bucket.name) ? 'text-brand' : 'text-muted-foreground'} />
                  <span class="truncate" title={bucket.name}>{bucketDisplayName(bucket.name)}</span>
                </span>
                {#if bucket.public}
                  <span class="text-[9px] px-1.5 py-0.5 bg-green-500/10 text-green-600 rounded">{$t("Storage.public")}</span>
                {/if}
              </button>
              <button
                onclick={() => deleteBucket(bucket)}
                disabled={deleteBucketMutation.isPending}
                class="mr-1 p-1.5 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                title={$t("Storage.delete_bucket")}
              >
                <Trash2 size={13} />
              </button>
            </div>
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
            <span>{$t("Storage.breadcrumb", { values: { bucket: selectedBucketId ?? "" } })}</span>
          </div>
        </div>
        
        <div class="flex items-center gap-2">
          <div class="relative group">
            <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-brand transition-colors" />
            <input 
              type="text" 
              bind:value={fileSearch}
              placeholder={$t("Storage.search_files")} 
              class="pl-9 pr-4 py-1.5 bg-muted/40 border-none rounded-full text-xs focus:ring-1 focus:ring-brand w-48 transition-all"
            />
          </div>
          <button 
            onclick={() => fileInput.click()}
            disabled={uploadMutation.isPending || !selectedBucketId}
            class="flex items-center gap-2 px-4 py-1.5 bg-brand text-white text-xs font-semibold rounded-full shadow-lg shadow-brand/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:hover:scale-100"
          >
            {#if uploadMutation.isPending}
              <Loader2 size={14} class="animate-spin" />
              <span>{$t("Storage.uploading")}</span>
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
              {#each visibleFiles as file (file.id || file.name)}
                  <tr class="hover:bg-muted/10 group transition-colors">
                    <td class="px-6 py-4">
                      <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded flex items-center justify-center bg-brand/5 text-brand">
                          <Folder size={16} />
                        </div>
                        <button onclick={() => previewFile(file.name)} class="font-medium group-hover:text-brand transition-colors text-left">
                          {file.name}
                        </button>
                      </div>
                    </td>
                    <td class="px-6 py-4 text-right text-muted-foreground tabular-nums">{file.size}</td>
                    <td class="px-6 py-4">
                      <span class="text-xs px-2 py-0.5 bg-muted rounded text-muted-foreground">{file.type}</span>
                    </td>
                    <td class="px-6 py-4 text-muted-foreground tabular-nums">{new Date(String(file.updated)).toLocaleString()}</td>
                    <td class="px-6 py-4 text-right">
                      <div class="flex items-center justify-end gap-1 text-muted-foreground">
                        <button onclick={() => previewFile(file.name)} class="p-1.5 hover:bg-muted hover:text-foreground rounded" title={$t("Storage.preview_file")}>
                          <Eye size={15} />
                        </button>
                        <button onclick={() => downloadMutation.mutate(file.name)} class="p-1.5 hover:bg-muted hover:text-foreground rounded" title={$t("Storage.download_file")}>
                          <Download size={15} />
                        </button>
                        <button onclick={() => copyPublicUrlMutation.mutate(file.name)} class="p-1.5 hover:bg-muted hover:text-foreground rounded" title={$t("Storage.copy_public_url")}>
                          <Copy size={15} />
                        </button>
                        <button onclick={() => deleteFile(file.name)} class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded" title={$t("Storage.delete_file")}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
            
            {#if visibleFiles.length === 0}
              <div class="py-24 flex flex-col items-center justify-center text-muted-foreground">
                <Folder size={48} class="mb-4 opacity-20" />
                <p>{files.length > 0 ? $t("Storage.no_matching_files") : $t("Storage.no_files")}</p>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </main>
  </div>
</div>
