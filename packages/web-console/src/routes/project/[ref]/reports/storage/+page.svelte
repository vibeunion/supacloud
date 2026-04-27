<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, HardDrive, ArrowLeft, Folder } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createQuery } from "@tanstack/svelte-query";

  const projectRef = $derived(page.params.ref);

  const storageStatsQuery = createQuery(() => ({
    queryKey: ["storage-stats", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT
            b.name as bucket_name,
            b.public,
            count(o.id) as object_count,
            coalesce(sum(o.metadata->>'size')::bigint, 0) as total_bytes,
            pg_size_pretty(coalesce(sum((o.metadata->>'size')::bigint), 0)) as total_size,
            max(o.created_at)::text as last_upload
          FROM storage.buckets b
          LEFT JOIN storage.objects o ON o.bucket_id = b.id
          GROUP BY b.id, b.name, b.public
          ORDER BY total_bytes DESC;`
        })
      });
      if (!res.ok) throw new Error("Failed to fetch storage stats");
      const data = await res.json();
      return data.rows || [];
    }
  }));

  const bucketStats = $derived((storageStatsQuery.data || []) as Record<string, unknown>[]);
  const isLoading = $derived(storageStatsQuery.isPending);



  function formatNum(n: unknown): string {
    return new Intl.NumberFormat().format(Number(n) || 0);
  }

  const totalObjects = $derived(bucketStats.reduce((acc, b) => acc + Number(b.object_count || 0), 0));
  const totalBytes = $derived(bucketStats.reduce((acc, b) => acc + Number(b.total_bytes || 0), 0));
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center gap-3">
    <a href={`/project/${projectRef}/reports`} class="p-2 hover:bg-muted/50 rounded-lg transition-colors">
      <ArrowLeft size={18} />
    </a>
    <div>
      <h1 class="text-2xl font-bold">Storage 报表</h1>
      <p class="text-sm text-muted-foreground mt-1">文件存储 Bucket 使用量和对象统计</p>
    </div>
  </div>

  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <div class="grid grid-cols-3 gap-3">
      <div class="rounded-xl border bg-card p-4">
        <div class="text-[10px] font-semibold text-muted-foreground uppercase">Buckets</div>
        <div class="text-xl font-bold mt-1 text-brand">{bucketStats.length}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="text-[10px] font-semibold text-muted-foreground uppercase">总文件数</div>
        <div class="text-xl font-bold mt-1">{formatNum(totalObjects)}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="text-[10px] font-semibold text-muted-foreground uppercase">总存储</div>
        <div class="text-xl font-bold mt-1">
          {totalBytes > 1073741824 ? (totalBytes / 1073741824).toFixed(2) + ' GB' :
           totalBytes > 1048576 ? (totalBytes / 1048576).toFixed(1) + ' MB' :
           totalBytes > 1024 ? (totalBytes / 1024).toFixed(0) + ' KB' : totalBytes + ' B'}
        </div>
      </div>
    </div>

    <div class="flex-1 rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h2 class="text-sm font-semibold flex items-center gap-2"><Folder size={14} /> Bucket 详情</h2>
      </div>
      {#if bucketStats.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <HardDrive size={32} class="opacity-20" />
          <p class="text-xs">暂无 Storage Bucket</p>
        </div>
      {:else}
        <div class="overflow-auto max-h-[55vh]">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b sticky top-0">
              <tr>
                <th class="px-4 py-2 font-semibold text-muted-foreground">Bucket</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">可见性</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground text-right">文件数</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground text-right">占用</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">最后上传</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20 font-mono">
              {#each bucketStats as bucket}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2 font-semibold">{bucket.bucket_name}</td>
                  <td class="px-4 py-2">
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-bold {bucket.public ? 'bg-green-500/10 text-green-600' : 'bg-amber-500/10 text-amber-600'}">
                      {bucket.public ? '公开' : '私有'}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-right tabular-nums">{formatNum(bucket.object_count)}</td>
                  <td class="px-4 py-2 text-right">{bucket.total_size}</td>
                  <td class="px-4 py-2 text-[10px] text-muted-foreground">{String(bucket.last_upload || "").substring(0, 19) || '-'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>
