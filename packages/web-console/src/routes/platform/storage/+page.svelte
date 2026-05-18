<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { Loader2, Database, HardDrive, Cloud, RefreshCw, ArrowRight, AlertTriangle, CheckCircle2, FolderOpen, Server } from "lucide-svelte";
  import { t } from "svelte-i18n";

  interface StorageStatus {
    backend: string;
    totalSize: string;
    usedSize: string;
    mountPoint: string;
    healthy: boolean;
  }

  interface BucketInfo {
    name: string;
    size: string;
    objects: number;
    public: boolean;
  }

  let status: StorageStatus | null = $state.raw(null);
  let buckets: BucketInfo[] = $state.raw([]);
  let isLoading = $state(true);
  let actionMsg: string | null = $state.raw(null);

  // Migration form
  let showMigration = $state(false);
  let migEndpoint = $state("");
  let migAccessKey = $state("");
  let migSecretKey = $state("");
  let migBucket = $state("");
  let isMigrating = $state(false);
    
  async function fetchStatus() {
    isLoading = true;
    try {
      const res = await apiClient("/v1/storage/status");
      if (res.ok) {
        const data = await res.json();
        status = {
          backend: data.backend || data.type || "local",
          totalSize: data.totalSize || data.total || "-",
          usedSize: data.usedSize || data.used || "-",
          mountPoint: data.mountPoint || data.path || "/var/lib/supabase/storage",
          healthy: data.healthy === true && data.status !== "unmounted"
        };
      }
    } catch {}

    // Fetch buckets
    try {
      const res = await apiClient("/v1/storage/default/buckets");
      if (res.ok) {
        const data = await res.json();
        buckets = Array.isArray(data) ? data : [];
      }
    } catch {}

    isLoading = false;
  }

  async function startMigration() {
    if (!migEndpoint || !migAccessKey || !migSecretKey) {
      actionMsg = `ERROR: ${$t("PlatformStorage.please_fill_in_complete_s3")}`;
      return;
    }
    if (!confirm($t("PlatformStorage.start_storage_migration_this_will"))) return;

    isMigrating = true;
    actionMsg = null;
    try {
      const res = await apiClient("/v1/storage/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          s3Url: migBucket || "supacloud",
          credentials: {
            endpoint: migEndpoint,
            access_key: migAccessKey,
            secret_key: migSecretKey
          }
        })
      });
      const data = await res.json();
      actionMsg = data instanceof Error ? String(data.message || "") : String(data) ? `SUCCESS: ${data.message}` : `SUCCESS: ${$t("PlatformStorage.migration_task_started")}`;
      showMigration = false;
    } catch (err: unknown) {
      actionMsg = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      isMigrating = false;
      setTimeout(() => actionMsg = null, 8000);
    }
  }

  onMount(() => fetchStatus());
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">{$t("PlatformStorage.storage_management")}</h2>
      <p class="text-xs text-muted-foreground mt-1">{$t("PlatformStorage.manage_supabase_storage_backend_minios3compatible")}</p>
    </div>
    <button onclick={() => fetchStatus()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
      <RefreshCw size={12} /> {$t("PlatformStorage.refresh")}
    </button>
  </div>

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('SUCCESS:') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- Storage Status Overview -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><Server size={14} /><span class="text-[10px] font-bold uppercase">{$t("PlatformStorage.backend_type")}</span></div>
        <div class="text-lg font-bold capitalize">{status?.backend || 'local'}</div>
        <div class="text-[10px] text-muted-foreground mt-1">{status?.backend === 'local' ? $t("Common.local_filesystem") : status?.backend === 's3' ? $t("Common.s3_compatible_storage") : status?.backend === 'minio' ? $t("Common.minio_object_storage") : $t("Common.local_storage")}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><HardDrive size={14} /><span class="text-[10px] font-bold uppercase">{$t("PlatformStorage.used_space")}</span></div>
        <div class="text-lg font-bold">{status?.usedSize || '-'}</div>
        <div class="text-[10px] text-muted-foreground mt-1">{$t("PlatformStorage.total")}: {status?.totalSize || '-'}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><FolderOpen size={14} /><span class="text-[10px] font-bold uppercase">{$t("PlatformStorage.mount_point")}</span></div>
        <div class="text-sm font-mono font-bold truncate">{status?.mountPoint || '-'}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2">
          {#if status?.healthy}<CheckCircle2 size={14} class="text-green-500" />{:else}<AlertTriangle size={14} class="text-red-500" />{/if}
          <span class="text-[10px] font-bold uppercase">{$t("PlatformStorage.health")}</span>
        </div>
        <div class="text-lg font-bold {status?.healthy ? 'text-green-600' : 'text-red-600'}">{status?.healthy ? $t("Common.healthy") : $t("Common.unhealthy")}</div>
      </div>
    </div>

    <!-- Storage Buckets -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Database size={16} /> {$t("PlatformStorage.bucket_list")}</h3>
      </div>
      {#if buckets.length === 0}
        <div class="p-8 text-center text-muted-foreground text-xs">{$t("PlatformStorage.no_bucket_data_yet_buckets")}</div>
      {:else}
        <div class="overflow-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b">
              <tr>
                <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("PlatformStorage.name")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("PlatformStorage.size")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("PlatformStorage.objects")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("PlatformStorage.access")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20">
              {#each buckets as bucket}
                <tr class="hover:bg-muted/10">
                  <td class="px-4 py-2.5 font-mono font-medium">{bucket.name}</td>
                  <td class="px-3 py-2.5 text-muted-foreground">{bucket.size || '-'}</td>
                  <td class="px-3 py-2.5 text-muted-foreground">{bucket.objects || 0}</td>
                  <td class="px-3 py-2.5">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold {bucket.public ? 'bg-amber-500/10 text-amber-600' : 'bg-green-500/10 text-green-600'}">{bucket.public ? $t("Common.public") : $t("Common.private")}</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <!-- Storage Migration -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Cloud size={16} /> {$t("PlatformStorage.storage_migration_local_s3minio")}</h3>
        <button onclick={() => showMigration = !showMigration} class="px-3 py-1 text-[10px] font-semibold rounded-md border hover:bg-muted/50 transition-colors">
          {showMigration ? $t("Common.collapse") : $t("PlatformStorage.configure_migration")}
        </button>
      </div>
      {#if !showMigration}
        <div class="p-4">
          <p class="text-xs text-muted-foreground">{$t("PlatformStorage.migrate_local_storage_files_to")}</p>
        </div>
      {:else}
        <div class="p-5 space-y-4">
          <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
            <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
            <p class="text-xs text-amber-700">{$t("PlatformStorage.storage_service_will_be_briefly")}</p>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label for="a11y-routes-platform-storage--page-svelte-201" class="text-xs font-semibold text-muted-foreground block mb-1">S3 Endpoint</label>
              <input id="a11y-routes-platform-storage--page-svelte-201" bind:value={migEndpoint} placeholder="https://s3.us-east-1.amazonaws.com" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
            <div>
              <label for="a11y-routes-platform-storage--page-svelte-205" class="text-xs font-semibold text-muted-foreground block mb-1">{$t("PlatformStorage.bucket_name")}</label>
              <input id="a11y-routes-platform-storage--page-svelte-205" bind:value={migBucket} placeholder="supacloud-storage" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
            <div>
              <label for="a11y-routes-platform-storage--page-svelte-209" class="text-xs font-semibold text-muted-foreground block mb-1">Access Key</label>
              <input id="a11y-routes-platform-storage--page-svelte-209" bind:value={migAccessKey} placeholder="AKIAIOSFODNN7EXAMPLE" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
            <div>
              <label for="a11y-routes-platform-storage--page-svelte-213" class="text-xs font-semibold text-muted-foreground block mb-1">Secret Key</label>
              <input id="a11y-routes-platform-storage--page-svelte-213" bind:value={migSecretKey} type="password" placeholder="••••••••" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
          </div>
          <button onclick={startMigration} disabled={isMigrating} class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors flex items-center gap-2 disabled:opacity-50">
            {#if isMigrating}<Loader2 size={14} class="animate-spin" />{:else}<ArrowRight size={14} />{/if}
            {$t("PlatformStorage.start_migration")}
          </button>
        </div>
      {/if}
    </div>

    <!-- Pigsty Storage Features Info -->
    <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
      <Database size={14} class="text-blue-600 mt-0.5 shrink-0" />
      <div class="text-xs text-blue-700">
        <b>{$t("PlatformStorage.pigsty_storage_capabilities")}</b>
        {$t("PlatformStorage.supports_local_filesystem_builtin_minio")}
        {$t("PlatformStorage.pgbackrest_backups_also_support_direct")}
      </div>
    </div>
  {/if}
</div>
