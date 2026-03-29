<script lang="ts">
  import { page } from "$app/state";
  import { Loader2, HardDrive, Link2, Shield, Globe, Copy } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  interface StorageConfig {
    name: string;
    description: string;
    value: string;
    unit: string;
  }

  let configs = $state<StorageConfig[]>([
    { name: "最大文件大小", description: "单个文件的最大上传大小", value: "50", unit: "MB" },
    { name: "最大上传并发", description: "同时上传的最大文件数量", value: "10", unit: "个" },
    { name: "图片转换", description: "启用图片变换（缩放、裁剪、格式转换）", value: "已启用", unit: "" },
    { name: "图片缓存 TTL", description: "图片变换结果的缓存时间", value: "3600", unit: "秒" },
    { name: "全局 S3 协议", description: "Storage 兼容的 S3 API 端点", value: "已启用", unit: "" },
  ]);

  const s3Endpoint = $derived(`http://${page.url?.hostname || 'localhost'}:54321/storage/v1/s3`);



  async function copyToClipboard(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">Storage 设置</h1>
    <p class="text-sm text-muted-foreground mt-1">存储服务配置和 S3 兼容端点</p>
  </div>


    <!-- S3 Endpoint -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><Globe size={18} /> S3 兼容端点</h2>
        <p class="text-xs text-muted-foreground mt-1">可使用标准 S3 SDK 和工具（如 AWS CLI）连接 Storage</p>
      </div>
      <div class="p-6 space-y-3">
        <div class="flex items-center gap-2">
          <div class="flex-1 px-3 py-2 text-sm font-mono rounded-lg border bg-muted/30 text-foreground overflow-hidden text-ellipsis">
            {s3Endpoint}
          </div>
          <button 
            onclick={() => copyToClipboard(s3Endpoint)}
            class="px-4 py-2 text-sm font-medium rounded-lg border bg-background hover:bg-muted/50 transition-colors flex items-center gap-2"
          >
            <Copy size={16} /> Copy
          </button>
        </div>
        <div class="text-xs text-muted-foreground space-y-1">
          <p>Region: <span class="font-mono text-foreground">local</span></p>
          <p>Access Key ID: <span class="font-mono text-foreground">project ref ({projectRef})</span></p>
          <p>Secret Access Key: <span class="font-mono text-foreground">service_role key</span></p>
        </div>
      </div>
    </div>

    <!-- Storage configs -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><HardDrive size={18} /> 配置</h2>
      </div>
      <div class="divide-y divide-border/20">
        {#each configs as cfg}
          <div class="flex items-center justify-between px-6 py-4 hover:bg-muted/5 transition-colors">
            <div>
              <span class="font-medium text-sm">{cfg.name}</span>
              <p class="text-[10px] text-muted-foreground">{cfg.description}</p>
            </div>
            <span class="px-2.5 py-1 rounded-lg bg-brand/10 text-brand font-mono text-xs font-bold">{cfg.value}{cfg.unit ? ` ${cfg.unit}` : ''}</span>
          </div>
        {/each}
      </div>
    </div>

</div>
