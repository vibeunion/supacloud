<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { ArrowLeft, Folder } from "lucide-svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";
  import MetricBlock from "@svadmin/ui/components/content/MetricBlock.svelte";
  import StatusBadge from "@svadmin/ui/components/content/StatusBadge.svelte";
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
            coalesce(sum(
              CASE
                WHEN o.metadata->>'size' ~ '^[0-9]+$' THEN (o.metadata->>'size')::bigint
                ELSE 0
              END
            ), 0) as total_bytes,
            pg_size_pretty(coalesce(sum(
              CASE
                WHEN o.metadata->>'size' ~ '^[0-9]+$' THEN (o.metadata->>'size')::bigint
                ELSE 0
              END
            ), 0)) as total_size,
            max(o.created_at)::text as last_upload
          FROM storage.buckets b
          LEFT JOIN storage.objects o ON o.bucket_id = b.id
          GROUP BY b.id, b.name, b.public
          ORDER BY total_bytes DESC;`
        })
      });
      if (!res.ok) return [];
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
      <h1 class="text-2xl font-bold">{$t("Reports.storage_report_title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Reports.storage_report_subtitle")}</p>
    </div>
  </div>

  {#if isLoading}
    <DataState state="loading" class="flex-1" />
  {:else}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <MetricBlock label={$t("Reports.buckets")} value={bucketStats.length} />
      <MetricBlock label={$t("Reports.total_files")} value={formatNum(totalObjects)} />
      <MetricBlock
        label={$t("Reports.total_storage")}
        value={totalBytes > 1073741824 ? (totalBytes / 1073741824).toFixed(2) + ' GB' :
          totalBytes > 1048576 ? (totalBytes / 1048576).toFixed(1) + ' MB' :
          totalBytes > 1024 ? (totalBytes / 1024).toFixed(0) + ' KB' : totalBytes + ' B'}
      />
    </div>

    <div class="flex-1 rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h2 class="text-sm font-semibold flex items-center gap-2"><Folder size={14} /> {$t("Reports.bucket_details")}</h2>
      </div>
      {#if bucketStats.length === 0}
        <DataState state="empty" title={$t("Reports.no_buckets")} class="m-4" />
      {:else}
        <div class="overflow-auto max-h-[55vh]">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b sticky top-0">
              <tr>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.bucket")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.visibility")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.file_count")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground text-right">{$t("Reports.storage_used")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.last_upload")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20 font-mono">
              {#each bucketStats as bucket}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2 font-semibold">{bucket.bucket_name}</td>
                  <td class="px-4 py-2">
                    <StatusBadge
                      status={bucket.public ? "success" : "warning"}
                      label={bucket.public ? $t("Reports.public") : $t("Reports.private")}
                    />
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
