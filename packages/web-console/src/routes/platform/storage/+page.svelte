<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { Loader2, Database, HardDrive, Cloud, RefreshCw, ArrowRight, AlertTriangle, CheckCircle2, FolderOpen, Server } from "lucide-svelte";
  import { locale } from "svelte-i18n";

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
  const isZh = $derived(($locale ?? "").toLowerCase().startsWith("zh"));
  const tr = (zh: string, en: string) => isZh ? zh : en;

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
          healthy: data.healthy !== false
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
      actionMsg = `❌ ${tr("请填写完整的 S3 连接信息", "Please fill in complete S3 connection info")}`;
      return;
    }
    if (!confirm(tr("⚠️ 确定要开始存储迁移吗？此操作将把当前本地存储的数据迁移到指定的 S3 兼容存储。", "⚠️ Start storage migration? This will migrate current local storage data to the specified S3-compatible backend."))) return;

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
      actionMsg = data instanceof Error ? data.message : String(data) ? `✅ ${data.message}` : `✅ ${tr("迁移任务已启动", "Migration task started")}`;
      showMigration = false;
    } catch (err: unknown) {
      actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
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
      <h2 class="text-xl font-bold">{tr("存储管理", "Storage Management")}</h2>
      <p class="text-xs text-muted-foreground mt-1">{tr("管理 Supabase Storage 后端、MinIO/S3 兼容存储和数据迁移", "Manage Supabase Storage backend, MinIO/S3-compatible storage, and migration")}</p>
    </div>
    <button onclick={() => fetchStatus()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
      <RefreshCw size={12} /> {tr("刷新", "Refresh")}
    </button>
  </div>

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">
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
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><Server size={14} /><span class="text-[10px] font-bold uppercase">{tr("后端类型", "Backend Type")}</span></div>
        <div class="text-lg font-bold capitalize">{status?.backend || 'local'}</div>
        <div class="text-[10px] text-muted-foreground mt-1">{status?.backend === 'local' ? tr('本地文件系统', 'Local filesystem') : status?.backend === 's3' ? tr('S3 兼容存储', 'S3-compatible storage') : status?.backend === 'minio' ? tr('MinIO 对象存储', 'MinIO object storage') : tr('本地存储', 'Local storage')}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><HardDrive size={14} /><span class="text-[10px] font-bold uppercase">{tr("已用空间", "Used Space")}</span></div>
        <div class="text-lg font-bold">{status?.usedSize || '-'}</div>
        <div class="text-[10px] text-muted-foreground mt-1">{tr("总计", "Total")}: {status?.totalSize || '-'}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><FolderOpen size={14} /><span class="text-[10px] font-bold uppercase">{tr("挂载点", "Mount Point")}</span></div>
        <div class="text-sm font-mono font-bold truncate">{status?.mountPoint || '-'}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2">
          {#if status?.healthy}<CheckCircle2 size={14} class="text-green-500" />{:else}<AlertTriangle size={14} class="text-red-500" />{/if}
          <span class="text-[10px] font-bold uppercase">{tr("健康状态", "Health")}</span>
        </div>
        <div class="text-lg font-bold {status?.healthy ? 'text-green-600' : 'text-red-600'}">{status?.healthy ? tr('正常', 'Healthy') : tr('异常', 'Unhealthy')}</div>
      </div>
    </div>

    <!-- Storage Buckets -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Database size={16} /> {tr("存储桶列表", "Bucket List")}</h3>
      </div>
      {#if buckets.length === 0}
        <div class="p-8 text-center text-muted-foreground text-xs">{tr("暂无存储桶数据。存储桶由 Supabase Storage 服务管理。", "No bucket data yet. Buckets are managed by Supabase Storage service.")}</div>
      {:else}
        <div class="overflow-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b">
              <tr>
                <th class="px-4 py-2.5 font-semibold text-muted-foreground">{tr("名称", "Name")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("大小", "Size")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("对象数", "Objects")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{tr("访问", "Access")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20">
              {#each buckets as bucket}
                <tr class="hover:bg-muted/10">
                  <td class="px-4 py-2.5 font-mono font-medium">{bucket.name}</td>
                  <td class="px-3 py-2.5 text-muted-foreground">{bucket.size || '-'}</td>
                  <td class="px-3 py-2.5 text-muted-foreground">{bucket.objects || 0}</td>
                  <td class="px-3 py-2.5">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold {bucket.public ? 'bg-amber-500/10 text-amber-600' : 'bg-green-500/10 text-green-600'}">{bucket.public ? tr('公开', 'Public') : tr('私有', 'Private')}</span>
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
        <h3 class="text-sm font-semibold flex items-center gap-2"><Cloud size={16} /> {tr("存储迁移（本地 → S3/MinIO）", "Storage Migration (Local → S3/MinIO)")}</h3>
        <button onclick={() => showMigration = !showMigration} class="px-3 py-1 text-[10px] font-semibold rounded-md border hover:bg-muted/50 transition-colors">
          {showMigration ? tr('收起', 'Collapse') : tr('配置迁移', 'Configure Migration')}
        </button>
      </div>
      {#if !showMigration}
        <div class="p-4">
          <p class="text-xs text-muted-foreground">{tr("将本地存储中的文件数据迁移到 S3 兼容的对象存储（如 MinIO、阿里云 OSS、Cloudflare R2 等）。Pigsty 支持一键切换存储后端。", "Migrate local storage files to S3-compatible object storage (e.g. MinIO, OSS, Cloudflare R2). Pigsty supports one-click backend switching.")}</p>
        </div>
      {:else}
        <div class="p-5 space-y-4">
          <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
            <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
            <p class="text-xs text-amber-700">{tr("迁移过程中存储服务将短暂不可用。请在低峰期执行，并确保目标存储有足够空间。", "Storage service will be briefly unavailable during migration. Please run during off-peak hours and ensure enough target storage space.")}</p>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label for="a11y-routes-platform-storage--page-svelte-201" class="text-xs font-semibold text-muted-foreground block mb-1">S3 Endpoint</label>
              <input id="a11y-routes-platform-storage--page-svelte-201" bind:value={migEndpoint} placeholder="https://s3.us-east-1.amazonaws.com" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
            <div>
              <label for="a11y-routes-platform-storage--page-svelte-205" class="text-xs font-semibold text-muted-foreground block mb-1">{tr("Bucket 名称", "Bucket Name")}</label>
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
            {tr("开始迁移", "Start Migration")}
          </button>
        </div>
      {/if}
    </div>

    <!-- Pigsty Storage Features Info -->
    <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
      <Database size={14} class="text-blue-600 mt-0.5 shrink-0" />
      <div class="text-xs text-blue-700">
        <b>{tr("Pigsty 存储能力：", "Pigsty storage capabilities:")}</b>
        {tr("支持本地文件系统、MinIO 内置对象存储、AWS S3、阿里云 OSS、Cloudflare R2、JuiceFS 分布式文件系统等。", "Supports local filesystem, built-in MinIO object storage, AWS S3, OSS, Cloudflare R2, JuiceFS and more.")}
        {tr("pgBackRest 备份也支持直接写入 S3 兼容存储，实现异地容灾。", "pgBackRest backups also support direct writes to S3-compatible storage for cross-site disaster recovery.")}
      </div>
    </div>
  {/if}
</div>
