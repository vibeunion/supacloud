<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { Loader2, Database, HardDrive, Cloud, RefreshCw, ArrowRight, AlertTriangle, CheckCircle2, FolderOpen, Server } from "lucide-svelte";

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

  let status: StorageStatus | null = $state(null);
  let buckets: BucketInfo[] = $state([]);
  let isLoading = $state(true);
  let actionMsg: string | null = $state(null);

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
      actionMsg = "❌ 请填写完整的 S3 连接信息";
      return;
    }
    if (!confirm("⚠️ 确定要开始存储迁移吗？此操作将把当前本地存储的数据迁移到指定的 S3 兼容存储。")) return;

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
      actionMsg = data.message ? `✅ ${data.message}` : "✅ 迁移任务已启动";
      showMigration = false;
    } catch (err: any) {
      actionMsg = `❌ ${err.message}`;
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
      <h2 class="text-xl font-bold">存储管理</h2>
      <p class="text-xs text-muted-foreground mt-1">管理 Supabase Storage 后端、MinIO/S3 兼容存储和数据迁移</p>
    </div>
    <button onclick={() => fetchStatus()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
      <RefreshCw size={12} /> 刷新
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
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><Server size={14} /><span class="text-[10px] font-bold uppercase">后端类型</span></div>
        <div class="text-lg font-bold capitalize">{status?.backend || 'local'}</div>
        <div class="text-[10px] text-muted-foreground mt-1">{status?.backend === 'local' ? '本地文件系统' : status?.backend === 's3' ? 'S3 兼容存储' : status?.backend === 'minio' ? 'MinIO 对象存储' : '本地存储'}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><HardDrive size={14} /><span class="text-[10px] font-bold uppercase">已用空间</span></div>
        <div class="text-lg font-bold">{status?.usedSize || '-'}</div>
        <div class="text-[10px] text-muted-foreground mt-1">总计: {status?.totalSize || '-'}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2"><FolderOpen size={14} /><span class="text-[10px] font-bold uppercase">挂载点</span></div>
        <div class="text-sm font-mono font-bold truncate">{status?.mountPoint || '-'}</div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center gap-2 text-muted-foreground mb-2">
          {#if status?.healthy}<CheckCircle2 size={14} class="text-green-500" />{:else}<AlertTriangle size={14} class="text-red-500" />{/if}
          <span class="text-[10px] font-bold uppercase">健康状态</span>
        </div>
        <div class="text-lg font-bold {status?.healthy ? 'text-green-600' : 'text-red-600'}">{status?.healthy ? '正常' : '异常'}</div>
      </div>
    </div>

    <!-- Storage Buckets -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Database size={16} /> 存储桶列表</h3>
      </div>
      {#if buckets.length === 0}
        <div class="p-8 text-center text-muted-foreground text-xs">暂无存储桶数据。存储桶由 Supabase Storage 服务管理。</div>
      {:else}
        <div class="overflow-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b">
              <tr>
                <th class="px-4 py-2.5 font-semibold text-muted-foreground">名称</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">大小</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">对象数</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">访问</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20">
              {#each buckets as bucket}
                <tr class="hover:bg-muted/10">
                  <td class="px-4 py-2.5 font-mono font-medium">{bucket.name}</td>
                  <td class="px-3 py-2.5 text-muted-foreground">{bucket.size || '-'}</td>
                  <td class="px-3 py-2.5 text-muted-foreground">{bucket.objects || 0}</td>
                  <td class="px-3 py-2.5">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold {bucket.public ? 'bg-amber-500/10 text-amber-600' : 'bg-green-500/10 text-green-600'}">{bucket.public ? '公开' : '私有'}</span>
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
        <h3 class="text-sm font-semibold flex items-center gap-2"><Cloud size={16} /> 存储迁移（本地 → S3/MinIO）</h3>
        <button onclick={() => showMigration = !showMigration} class="px-3 py-1 text-[10px] font-semibold rounded-md border hover:bg-muted/50 transition-colors">
          {showMigration ? '收起' : '配置迁移'}
        </button>
      </div>
      {#if !showMigration}
        <div class="p-4">
          <p class="text-xs text-muted-foreground">将本地存储中的文件数据迁移到 S3 兼容的对象存储（如 MinIO、阿里云 OSS、Cloudflare R2 等）。Pigsty 支持一键切换存储后端。</p>
        </div>
      {:else}
        <div class="p-5 space-y-4">
          <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
            <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
            <p class="text-xs text-amber-700">迁移过程中存储服务将短暂不可用。请在低峰期执行，并确保目标存储有足够空间。</p>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-semibold text-muted-foreground block mb-1">S3 Endpoint</label>
              <input bind:value={migEndpoint} placeholder="https://s3.us-east-1.amazonaws.com" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
            <div>
              <label class="text-xs font-semibold text-muted-foreground block mb-1">Bucket 名称</label>
              <input bind:value={migBucket} placeholder="supacloud-storage" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
            <div>
              <label class="text-xs font-semibold text-muted-foreground block mb-1">Access Key</label>
              <input bind:value={migAccessKey} placeholder="AKIAIOSFODNN7EXAMPLE" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
            <div>
              <label class="text-xs font-semibold text-muted-foreground block mb-1">Secret Key</label>
              <input bind:value={migSecretKey} type="password" placeholder="••••••••" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
            </div>
          </div>
          <button onclick={startMigration} disabled={isMigrating} class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors flex items-center gap-2 disabled:opacity-50">
            {#if isMigrating}<Loader2 size={14} class="animate-spin" />{:else}<ArrowRight size={14} />{/if}
            开始迁移
          </button>
        </div>
      {/if}
    </div>

    <!-- Pigsty Storage Features Info -->
    <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
      <Database size={14} class="text-blue-600 mt-0.5 shrink-0" />
      <div class="text-xs text-blue-700">
        <b>Pigsty 存储能力：</b>
        支持本地文件系统、MinIO 内置对象存储、AWS S3、阿里云 OSS、Cloudflare R2、JuiceFS 分布式文件系统等。
        pgBackRest 备份也支持直接写入 S3 兼容存储，实现异地容灾。
      </div>
    </div>
  {/if}
</div>
