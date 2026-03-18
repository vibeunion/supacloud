<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, Key, Eye, EyeOff, Copy, Clock, Shield } from "lucide-svelte";

  let jwtSecret = $state("");
  let jwtExpiry = $state(3600);
  let isLoading = $state(true);
  let showSecret = $state(false);

  const projectRef = $derived(page.params.ref);

  async function fetchJwt() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}`);
      if (res.ok) {
        const data = await res.json();
        jwtSecret = data.config?.jwt_secret || data.jwt_secret || "super-secret-jwt-token-with-at-least-32-characters-long";
        jwtExpiry = data.config?.jwt_expiry || 3600;
      }
    } catch (err) {
      console.error("Failed to fetch JWT config:", err);
    } finally {
      isLoading = false;
    }
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  onMount(() => { fetchJwt(); });

  const maskedSecret = $derived(jwtSecret ? jwtSecret.substring(0, 8) + "•".repeat(Math.max(jwtSecret.length - 8, 16)) : "");
  const expiryLabel = $derived(
    jwtExpiry >= 86400 ? `${Math.floor(jwtExpiry / 86400)} 天` :
    jwtExpiry >= 3600 ? `${Math.floor(jwtExpiry / 3600)} 小时` :
    `${jwtExpiry} 秒`
  );
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">JWT 配置</h1>
    <p class="text-sm text-muted-foreground mt-1">管理项目的 JSON Web Token 签名密钥和有效期</p>
  </div>

  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- JWT Secret -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><Key size={18} /> JWT Secret</h2>
        <p class="text-xs text-muted-foreground mt-1">此密钥用于签署所有 Access Token 和 Refresh Token。请妥善保管，不要泄露。</p>
      </div>
      <div class="p-6 space-y-3">
        <div class="flex items-center gap-2">
          <div class="flex-1 px-3 py-2.5 text-sm font-mono rounded-lg border bg-muted/30 text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
            {showSecret ? jwtSecret : maskedSecret}
          </div>
          <button onclick={() => showSecret = !showSecret}
            class="px-3 py-2.5 rounded-lg border hover:bg-muted/50 transition-colors" title={showSecret ? '隐藏' : '显示'}>
            {#if showSecret}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
          </button>
          <button onclick={() => copyText(jwtSecret)}
            class="px-3 py-2.5 rounded-lg border hover:bg-muted/50 transition-colors" title="复制">
            <Copy size={14} />
          </button>
        </div>
        <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
          <Shield size={14} class="text-amber-600 mt-0.5 shrink-0" />
          <p class="text-xs text-amber-700"><b>安全提示</b>：JWT Secret 对所有 Supabase 服务至关重要。修改此密钥将导致所有现有 Token 失效，用户需要重新登录。</p>
        </div>
      </div>
    </div>

    <!-- JWT Expiry -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><Clock size={18} /> Token 有效期</h2>
      </div>
      <div class="divide-y divide-border/20">
        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <span class="font-medium text-sm">Access Token 有效期</span>
            <p class="text-[10px] text-muted-foreground mt-0.5">GoTrue 签发的 JWT Access Token 的默认有效期</p>
          </div>
          <span class="px-3 py-1 rounded-lg bg-brand/10 text-brand font-mono text-sm font-bold">{expiryLabel}</span>
        </div>
        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <span class="font-medium text-sm">Refresh Token 轮换</span>
            <p class="text-[10px] text-muted-foreground mt-0.5">每次使用 Refresh Token 时自动签发新的 Refresh Token</p>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/10 text-green-600">已启用</span>
        </div>
        <div class="flex items-center justify-between px-6 py-4">
          <div>
            <span class="font-medium text-sm">JWT 算法</span>
            <p class="text-[10px] text-muted-foreground mt-0.5">Token 签名使用的加密算法</p>
          </div>
          <span class="px-3 py-1 rounded-lg bg-muted font-mono text-xs font-bold">HS256</span>
        </div>
      </div>
    </div>
  {/if}
</div>
