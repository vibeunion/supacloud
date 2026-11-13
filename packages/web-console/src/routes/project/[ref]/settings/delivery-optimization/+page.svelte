<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { Gauge, Loader2, Save, ShieldCheck, Zap } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  type CacheMode = "disabled" | "public_versioned" | "public";

  interface DeliveryPolicy {
    compression: true;
    cache_mode: CacheMode;
    cache_ttl_seconds: number;
    stale_while_revalidate_seconds: number;
  }

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();
  let cacheMode = $state<CacheMode>("public_versioned");
  let cacheTtl = $state(31536000);
  let staleSeconds = $state(3600);

  const policyQuery = createQuery(() => ({
    queryKey: ["delivery-optimization", projectRef],
    queryFn: async () => {
      const response = await apiClient(`/v1/projects/${projectRef}/config/delivery-optimization`);
      const data = await response.json() as { delivery_optimization?: DeliveryPolicy; message?: string };
      if (!response.ok || !data.delivery_optimization) throw new Error(data.message || "Failed to load delivery policy");
      return data.delivery_optimization;
    },
  }));

  $effect(() => {
    const policy = policyQuery.data;
    if (!policy) return;
    cacheMode = policy.cache_mode;
    cacheTtl = policy.cache_ttl_seconds;
    staleSeconds = policy.stale_while_revalidate_seconds;
  });

  const saveMutation = createMutation(() => ({
    mutationFn: async () => {
      const response = await apiClient(`/v1/projects/${projectRef}/config/delivery-optimization`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cache_mode: cacheMode,
          cache_ttl_seconds: cacheTtl,
          stale_while_revalidate_seconds: staleSeconds,
        }),
      });
      const data = await response.json() as { message?: string };
      if (!response.ok) throw new Error(data.message || "Failed to save delivery policy");
      return data;
    },
    onSuccess: () => {
      toast.success("交付优化策略已保存，静态网关路由正在刷新");
      queryClient.invalidateQueries({ queryKey: ["delivery-optimization", projectRef] });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
  }));
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h2 class="text-2xl font-bold">交付优化</h2>
      <p class="mt-1 text-sm text-muted-foreground">使用平台级压缩与静态缓存降低源站负载。</p>
    </div>
    <button
      class="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
      disabled={saveMutation.isPending || policyQuery.isPending}
      onclick={() => saveMutation.mutate()}
    >
      {#if saveMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
      保存策略
    </button>
  </div>

  {#if policyQuery.isPending}
    <div class="flex flex-1 items-center justify-center"><Loader2 size={30} class="animate-spin text-brand opacity-60" /></div>
  {:else if policyQuery.error}
    <div class="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">{policyQuery.error.message}</div>
  {:else}
    <div class="grid gap-4 lg:grid-cols-3">
      <div class="rounded-xl border bg-card p-5">
        <div class="flex items-center gap-2 text-sm font-semibold"><Gauge size={16} class="text-brand" />交付档案</div>
        <p class="mt-2 text-xs text-muted-foreground">平台根据项目部署类型自动区分 API、静态前端与 SSR。API 和 SSR 动态响应不会进入这项静态资源缓存。</p>
        <div class="mt-4 rounded-md bg-muted/50 px-3 py-2 text-xs">当前设置只影响公开静态资源</div>
      </div>

      <div class="rounded-xl border bg-card p-5">
        <div class="flex items-center gap-2 text-sm font-semibold"><Zap size={16} class="text-brand" />缓存策略</div>
        <p class="mt-2 text-xs text-muted-foreground">只缓存公开 GET/HEAD 资源，带授权或私有响应保持源站语义。</p>
        <select bind:value={cacheMode} class="mt-4 w-full rounded-md border bg-background px-3 py-2 text-sm">
          <option value="disabled">关闭共享缓存</option>
          <option value="public_versioned">仅版本化资源</option>
          <option value="public">公开资源</option>
        </select>
      </div>

      <div class="rounded-xl border bg-card p-5">
        <div class="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} class="text-brand" />安全默认值</div>
        <p class="mt-2 text-xs text-muted-foreground">压缩始终启用；平台不会自动重写 HTML、JavaScript 或认证响应。</p>
        <p class="mt-4 text-xs text-muted-foreground">仅对公开 GET/HEAD 静态资源启用缓存，动态页面与 API 保持源站语义。</p>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <label class="rounded-xl border bg-card p-5 text-sm">
        <span class="font-semibold">缓存 TTL（秒）</span>
        <input type="number" min="0" max="31536000" bind:value={cacheTtl} class="mt-3 w-full rounded-md border bg-background px-3 py-2 font-mono" />
      </label>
      <label class="rounded-xl border bg-card p-5 text-sm">
        <span class="font-semibold">Stale-While-Revalidate（秒）</span>
        <input type="number" min="0" max="86400" bind:value={staleSeconds} class="mt-3 w-full rounded-md border bg-background px-3 py-2 font-mono" />
      </label>
    </div>

    <div class="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 text-xs text-blue-700">
      当前策略会驱动 SupaCloud 管理的 Caddy 静态资源缓存。缓存响应会返回标准 <code>Cache-Status</code>，后续可在控制台展示命中率和节省流量。
    </div>
  {/if}
</div>
