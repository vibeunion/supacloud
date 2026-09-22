<script lang="ts">
  import { page } from "$app/state";
  import { onDestroy } from "svelte";
  import { Loader2, Copy, RefreshCw, KeyRound, ShieldCheck } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { loadJwtSettings, type JwtSettings } from "$lib/jwt-settings";

  const projectRef = $derived(page.params.ref);

  let snapshot = $state<JwtSettings | null>(null);
  let failed = $state(false);
  let loading = $state(false);
  let controller: AbortController | null = null;
  let scope = 0;
  let copying = $state(false);
  let destroyed = false;

  async function load(ref: string | undefined) {
    controller?.abort();
    const next = new AbortController();
    controller = next;
    scope += 1;
    copying = false;
    if (!ref) {
      snapshot = null;
      failed = false;
      loading = false;
      return;
    }
    loading = true;
    failed = false;
    try {
      const result = await loadJwtSettings(ref, fetch, next.signal);
      if (next.signal.aborted) return;
      snapshot = result;
    } catch {
      if (next.signal.aborted) return;
      snapshot = null;
      failed = true;
    } finally {
      if (!next.signal.aborted) loading = false;
    }
  }

  $effect(() => {
    const ref = projectRef;
    load(ref);
  });

  onDestroy(() => {
    destroyed = true;
    scope += 1;
    controller?.abort();
  });

  const signing = $derived(snapshot?.signing ?? null);
  const policy = $derived(snapshot?.policy ?? null);
  const ownerPath = $derived(
    snapshot?.executionMode === "shared" && snapshot.authorityProjectRef
      ? `/project/${encodeURIComponent(snapshot.authorityProjectRef)}/settings/jwt`
      : null,
  );

  function formatSeconds(seconds: number | null): string {
    if (seconds === null) return "不可用";
    if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
    if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
    if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
    return `${seconds} 秒`;
  }

  async function copyJwks() {
    const value = signing?.jwksUrl;
    if (copying || !value) return;
    const started = scope;
    copying = true;
    try {
      await navigator.clipboard.writeText(value);
      if (!destroyed && scope === started) toast.success("已复制");
    } catch {
      if (!destroyed && scope === started) toast.error("复制失败");
    } finally {
      if (scope === started) copying = false;
    }
  }
</script>

<div class="flex h-full flex-col space-y-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">JWT 配置</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        展示 backend 允许公开的签名状态、JWKS endpoint 与 Access Token 有效期。
      </p>
    </div>
    <button
      title="刷新"
      class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-muted/50 disabled:opacity-50"
      onclick={() => load(projectRef)}
      disabled={!projectRef || loading}
    >
      {#if loading}<Loader2 size={13} class="animate-spin" />{:else}<RefreshCw size={13} />{/if}
      刷新
    </button>
  </div>

  {#if failed}
    <div role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-xs text-red-700">
      JWT 配置暂不可用，请稍后重试。
    </div>
  {:else if loading && !snapshot}
    <div class="flex flex-1 items-center justify-center"><Loader2 size={32} class="animate-spin text-brand opacity-50" /></div>
  {:else if snapshot}
    {#if snapshot.executionMode === "shared"}
      <section class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6">
        <div class="flex items-start gap-3">
          <ShieldCheck size={22} class="mt-0.5 shrink-0 text-amber-700" />
          <div>
            <h2 class="font-semibold">JWT 签名由 SupAuth owner 项目管理</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              当前项目使用 shared auth runtime；控制台不会从本项目的旧 config fallback 或展示本地 key material。
            </p>
          </div>
        </div>
        {#if ownerPath}
          <a class="mt-4 inline-flex rounded-lg border px-3 py-2 text-xs hover:bg-muted/50" href={ownerPath}>前往 owner JWT 页面</a>
        {/if}
      </section>
    {:else if snapshot.executionMode === "external"}
      <div class="rounded-lg border bg-card p-4 text-sm text-muted-foreground">JWT 由外部认证服务管理</div>
    {:else}
      <div class="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <section class="rounded-xl border bg-card">
          <div class="flex items-center justify-between gap-3 border-b bg-muted/20 px-5 py-4">
            <div class="flex items-center gap-2"><ShieldCheck size={18} /><h2 class="font-semibold">签名状态</h2></div>
          </div>
          <div class="space-y-4 p-5">
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="rounded-lg border bg-muted/20 p-4">
                <div class="text-xs text-muted-foreground">当前签名算法</div>
                <div class="mt-1 font-mono text-lg font-semibold">{signing?.algorithm ?? "不可用"}</div>
              </div>
              <div class="rounded-lg border bg-muted/20 p-4">
                <div class="text-xs text-muted-foreground">OAuth/OIDC 迁移状态</div>
                <div class="mt-1 text-sm font-semibold">{signing?.migrationStatus ?? "不可用"}</div>
                <div class="mt-1 text-[10px] text-muted-foreground">
                  OAuth Server：{signing === null ? "不可用" : signing.oauthEnabled ? "已启用" : "未启用"}
                </div>
              </div>
            </div>
            <div class="grid gap-3 text-sm sm:grid-cols-[140px_1fr]">
              <span class="text-muted-foreground">Issuer</span>
              <code class="break-all rounded bg-muted/30 px-2 py-1 text-xs">{signing?.issuer ?? "不可用"}</code>
              <span class="text-muted-foreground">Signing key ID</span>
              <code class="break-all rounded bg-muted/30 px-2 py-1 text-xs">{signing?.keyId ?? "不可用"}</code>
            </div>
          </div>
        </section>

        <section class="rounded-xl border bg-card">
          <div class="flex items-center gap-2 border-b bg-muted/20 px-5 py-4"><KeyRound size={18} /><h2 class="font-semibold">Token 生命周期</h2></div>
          <div class="divide-y">
            <div class="flex items-center justify-between gap-4 px-5 py-4">
              <div class="text-sm font-medium">Access Token 有效期</div>
              <span class="rounded-lg bg-brand/10 px-3 py-1 font-mono text-sm font-semibold text-brand">{formatSeconds(policy?.accessExpiry ?? null)}</span>
            </div>
            <div class="flex items-center justify-between gap-4 px-5 py-4">
              <div class="text-sm font-medium">Refresh Token 轮换</div>
              <span class="rounded-full px-2.5 py-1 text-[10px] font-semibold">
                {policy === null ? "不可用" : policy.refreshRotation ? "已启用" : "已禁用"}
              </span>
            </div>
          </div>
        </section>
      </div>

      <section class="rounded-xl border bg-card">
        <div class="flex items-center gap-2 border-b bg-muted/20 px-5 py-4"><KeyRound size={18} /><h2 class="font-semibold">公开 JWKS</h2></div>
        <div class="space-y-4 p-5">
          <div class="grid items-start gap-2 md:grid-cols-[120px_1fr_auto]">
            <span class="pt-2 text-xs font-medium text-muted-foreground">JWKS URL</span>
            <code class="break-all rounded-lg border bg-muted/20 px-3 py-2 text-xs">{signing?.jwksUrl ?? "不可用"}</code>
            {#if signing?.jwksUrl}
              <button
                class="rounded-lg border p-2 hover:bg-muted/50 disabled:opacity-50"
                title="复制 JWKS URL"
                disabled={copying}
                onclick={copyJwks}
              ><Copy size={14} /></button>
            {/if}
          </div>
        </div>
      </section>
    {/if}
  {/if}
</div>