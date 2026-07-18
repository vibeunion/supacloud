<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import {
    createProjectLoadToken,
    isCurrentProjectLoad,
    type ProjectLoadToken,
  } from "$lib/project-load-guard";
  import { authApiResponseMessage, readAuthApiPayload } from "../../auth-api-response";
  import {
    buildJwtTruth,
    emptyJwtTruth,
    normalizeAuthRuntime,
    type AuthRuntimeDescriptor,
    type JwtTruth,
    type SigningSource,
  } from "./jwt-truth";
  import {
    AlertTriangle,
    Clock,
    Copy,
    KeyRound,
    Loader2,
    RefreshCw,
    ShieldCheck,
  } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  type LoadResult = { label: string; payload: unknown | null; error: string | null };
  type JwtLoadResult = { nextTruth: JwtTruth; errors: string[] };

  const projectRef = $derived(page.params.ref ?? "");
  let loadRevision = 0;

  let loading = $state(true);
  let loadErrors = $state<string[]>([]);
  let truth = $state<JwtTruth>(emptyJwtTruth());
  let authRuntime = $state<AuthRuntimeDescriptor | null>(null);

  const ownerJwtPath = $derived(authRuntime?.mode === "shared"
    ? `/project/${encodeURIComponent(authRuntime.authorityProjectRef)}/settings/jwt`
    : null);

  function isCurrentLoad(loadToken: ProjectLoadToken): boolean {
    return isCurrentProjectLoad(loadToken, projectRef, loadRevision);
  }

  async function loadEndpoint(label: string, path: string): Promise<LoadResult> {
    try {
      const response = await apiClient(path);
      const payload = await readAuthApiPayload(response);
      if (!response.ok) {
        return { label, payload: null, error: authApiResponseMessage(payload, `${label}请求失败（${response.status}）`) };
      }
      return { label, payload, error: null };
    } catch (error) {
      return { label, payload: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function errorsFrom(loadResults: LoadResult[]): string[] {
    return loadResults
      .filter((loadResult) => loadResult.error)
      .map((loadResult) => `${loadResult.label}：${loadResult.error}`);
  }

  async function loadOwnerOrLocalTruth(encodedProjectRef: string): Promise<JwtLoadResult> {
    const [authConfig, oauthStatus] = await Promise.all([
      loadEndpoint("认证配置", `/v1/projects/${encodedProjectRef}/config/auth`),
      loadEndpoint("OAuth/JWKS 状态", `/v1/projects/${encodedProjectRef}/auth/oauth-server`),
    ]);
    return {
      nextTruth: buildJwtTruth(authConfig.payload, oauthStatus.payload),
      errors: errorsFrom([authConfig, oauthStatus]),
    };
  }

  async function loadJwtTruth(ref: string): Promise<void> {
    loadRevision += 1;
    const loadToken = createProjectLoadToken(ref, loadRevision);
    loading = true;
    loadErrors = [];
    truth = emptyJwtTruth();
    authRuntime = null;
    const encodedRef = encodeURIComponent(ref);
    const runtimeResult = await loadEndpoint("认证运行时", `/v1/projects/${encodedRef}/auth/runtime`);
    if (!isCurrentLoad(loadToken)) return;
    if (runtimeResult.error) {
      loadErrors = errorsFrom([runtimeResult]);
      loading = false;
      return;
    }
    const nextRuntime = normalizeAuthRuntime(runtimeResult.payload);
    if (!nextRuntime) {
      loadErrors = ["认证运行时：响应格式无效"];
      loading = false;
      return;
    }
    authRuntime = nextRuntime;
    if (nextRuntime.mode !== "shared") {
      const localTruth = await loadOwnerOrLocalTruth(encodedRef);
      if (!isCurrentLoad(loadToken)) return;
      truth = localTruth.nextTruth;
      loadErrors = localTruth.errors;
    }
    loading = false;
  }

  function formatSeconds(seconds: number | null): string {
    if (seconds === null) return "不可用";
    if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
    if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
    if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
    return `${seconds} 秒`;
  }

  function sourceLabel(source: SigningSource): string {
    if (source === "oauth_status") return "OAuth 状态 signing_alg";
    return "不可用";
  }

  function migrationLabel(migrationStatus: string | null): string {
    if (!migrationStatus) return "不可用";
    if (migrationStatus === "not_migrated") return "尚未迁移到项目级 JWKS";
    return migrationStatus;
  }

  async function copyText(textToCopy: string) {
    try {
      await navigator.clipboard.writeText(textToCopy);
      toast.success("已复制");
    } catch {
      toast.error("复制失败");
    }
  }

  $effect(() => {
    const ref = projectRef;
    if (ref) void loadJwtTruth(ref);
  });
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
      class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-muted/50 disabled:opacity-50"
      onclick={() => loadJwtTruth(projectRef)}
      disabled={loading}
    >
      <RefreshCw size={13} class={loading ? "animate-spin" : ""} />刷新
    </button>
  </div>

  {#if loading}
    <div class="flex flex-1 items-center justify-center"><Loader2 size={32} class="animate-spin text-brand opacity-50" /></div>
  {:else if authRuntime?.mode === "shared"}
    <section class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6">
      <div class="flex items-start gap-3">
        <ShieldCheck size={22} class="mt-0.5 shrink-0 text-amber-700" />
        <div>
          <h2 class="font-semibold">JWT 签名由 SupAuth owner 项目管理</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            当前项目使用 shared auth runtime；控制台不会从本项目的旧 config fallback 或展示本地 key material。
          </p>
          <div class="mt-4 grid gap-2 text-xs sm:grid-cols-[180px_1fr]">
            <span class="text-muted-foreground">Runtime mode</span><code>{authRuntime.mode}</code>
            <span class="text-muted-foreground">Authority project</span><code>{authRuntime.authorityProjectRef}</code>
            <span class="text-muted-foreground">Configuration management</span><code>{authRuntime.configurationManagement ?? "owner_only"}</code>
            <span class="text-muted-foreground">Backend management path</span><code>{authRuntime.ownerManagementPath ?? "不可用"}</code>
          </div>
          {#if ownerJwtPath}
            <a class="mt-4 inline-flex rounded-lg border px-3 py-2 text-xs hover:bg-muted/50" href={ownerJwtPath}>前往 owner JWT 页面</a>
          {/if}
        </div>
      </div>
    </section>
  {:else}
    {#if loadErrors.length > 0}
      <div class="rounded-lg border border-amber-500/25 bg-amber-500/5 p-4 text-xs text-amber-800">
        <div class="mb-2 flex items-center gap-2 font-semibold"><AlertTriangle size={14} />部分实时信息不可用</div>
        <ul class="list-disc space-y-1 pl-5">
          {#each loadErrors as error (error)}<li>{error}</li>{/each}
        </ul>
      </div>
    {/if}

    <div class="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
      <section class="rounded-xl border bg-card">
        <div class="flex items-center justify-between gap-3 border-b bg-muted/20 px-5 py-4">
          <div class="flex items-center gap-2"><ShieldCheck size={18} /><h2 class="font-semibold">签名状态</h2></div>
          <span class="rounded-full px-2.5 py-1 text-[10px] font-semibold {truth.signingAlgorithm ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700'}">
            {truth.signingAlgorithm ? "已读取" : "不可用"}
          </span>
        </div>
        <div class="space-y-4 p-5">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border bg-muted/20 p-4">
              <div class="text-xs text-muted-foreground">当前签名算法</div>
              <div class="mt-1 font-mono text-lg font-semibold">{truth.signingAlgorithm ?? "不可用"}</div>
              <div class="mt-1 text-[10px] text-muted-foreground">来源：{sourceLabel(truth.signingSource)}</div>
            </div>
            <div class="rounded-lg border bg-muted/20 p-4">
              <div class="text-xs text-muted-foreground">OAuth/OIDC 迁移状态</div>
              <div class="mt-1 text-sm font-semibold">{migrationLabel(truth.migrationStatus)}</div>
              <div class="mt-1 text-[10px] text-muted-foreground">
                OAuth Server：{truth.oauthEnabled === null ? "不可用" : truth.oauthEnabled ? "已启用" : "未启用"}
              </div>
            </div>
          </div>

          <div class="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 text-xs text-blue-800">
            私有签名材料和旧版 JWT secret 不会由这些管理接口返回，因此控制台不会展示、猜测或生成默认 secret。
          </div>

          <div class="grid gap-3 text-sm sm:grid-cols-[140px_1fr]">
            <span class="text-muted-foreground">Issuer</span>
            <code class="break-all rounded bg-muted/30 px-2 py-1 text-xs">{truth.issuer ?? "不可用"}</code>
            <span class="text-muted-foreground">Signing key ID</span>
            <code class="break-all rounded bg-muted/30 px-2 py-1 text-xs">{truth.signingKeyId ?? "不可用"}</code>
          </div>
        </div>
      </section>

      <section class="rounded-xl border bg-card">
        <div class="flex items-center gap-2 border-b bg-muted/20 px-5 py-4"><Clock size={18} /><h2 class="font-semibold">Token 生命周期</h2></div>
        <div class="divide-y">
          <div class="flex items-center justify-between gap-4 px-5 py-4">
            <div><div class="text-sm font-medium">Access Token 有效期</div><p class="mt-0.5 text-[10px] text-muted-foreground">来自 config/auth 的 jwt_expiry 或旧版 jwt_exp。</p></div>
            <span class="rounded-lg bg-brand/10 px-3 py-1 font-mono text-sm font-semibold text-brand">{formatSeconds(truth.accessExpiry)}</span>
          </div>
          <div class="flex items-center justify-between gap-4 px-5 py-4">
            <div><div class="text-sm font-medium">Refresh Token 轮换</div><p class="mt-0.5 text-[10px] text-muted-foreground">从项目认证配置读取，不在此页面假定默认状态。</p></div>
            <span class="rounded-full px-2.5 py-1 text-[10px] font-semibold {truth.refreshRotation === null ? 'bg-muted text-muted-foreground' : truth.refreshRotation ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700'}">
              {truth.refreshRotation === null ? "不可用" : truth.refreshRotation ? "已启用" : "已禁用"}
            </span>
          </div>
        </div>
        <div class="m-5 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-800">
          Refresh Token 是认证服务管理的长期凭证，不是由 JWT secret 或 JWKS 私钥签名的 JWT；它的轮换与重用策略请在“认证 → 会话”中配置。
        </div>
      </section>
    </div>

    <section class="rounded-xl border bg-card">
      <div class="flex items-center justify-between gap-3 border-b bg-muted/20 px-5 py-4">
        <div class="flex items-center gap-2"><KeyRound size={18} /><h2 class="font-semibold">公开 JWKS</h2></div>
        <span class="text-xs text-muted-foreground">安全 endpoint 信息</span>
      </div>
      <div class="space-y-4 p-5">
        <div class="grid items-start gap-2 md:grid-cols-[120px_1fr_auto]">
          <span class="pt-2 text-xs font-medium text-muted-foreground">JWKS URL</span>
          <code class="break-all rounded-lg border bg-muted/20 px-3 py-2 text-xs">{truth.jwksUrl ?? "不可用"}</code>
          {#if truth.jwksUrl}
            <button class="rounded-lg border p-2 hover:bg-muted/50" title="复制 JWKS URL" onclick={() => copyText(truth.jwksUrl!)}><Copy size={14} /></button>
          {/if}
        </div>
        <div class="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 text-xs text-blue-800">
          Management API 当前只返回 allowlisted status、签名 key ID 和 JWKS URL，不返回实际 key 列表。
          因此本页不会读取项目 raw config，也不会把 legacy HS256 对称 key 或私钥字段当作公开 JWKS。
        </div>
      </div>
    </section>
  {/if}
</div>
