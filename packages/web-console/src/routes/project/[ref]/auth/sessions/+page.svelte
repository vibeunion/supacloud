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
    buildSessionPolicyPatch,
    cloneSessionDraft,
    dependentStatusLabel,
    emptySessionDraft,
    formatSessionSeconds,
    parseAuthManagedBoundary,
    parseSessionConfigResponse,
    resolveSessionSaveDirective,
    SessionPolicyInputError,
    type AuthApplyWarning,
    type AuthManagedBoundary,
    type JsonObject,
    type SessionDraft,
  } from "./session-policy";
  import {
    AlertTriangle,
    CheckCircle2,
    Clock,
    Loader2,
    RefreshCw,
    Save,
    Shield,
    Timer,
  } from "lucide-svelte";

  type ConfigFetchResult =
    | { ok: true; nextDraft: SessionDraft }
    | { ok: false; message: string; managedBoundary: AuthManagedBoundary | null };

  const projectRef = $derived(page.params.ref ?? "");

  let draft = $state<SessionDraft>(emptySessionDraft());
  let initialDraft = $state<SessionDraft>(emptySessionDraft());
  let loading = $state(true);
  let saving = $state(false);
  let loaded = $state(false);
  let errorMessage = $state<string | null>(null);
  let formError = $state<string | null>(null);
  let successMessage = $state<string | null>(null);
  let applyWarning = $state<AuthApplyWarning | null>(null);
  let managedBoundary = $state<AuthManagedBoundary | null>(null);
  let activeLoadToken: ProjectLoadToken | null = null;
  let stateProjectRef: string | null = null;
  let loadRevision = 0;

  const hasChanges = $derived(JSON.stringify(draft) !== JSON.stringify(initialDraft));
  const saveDisabled = $derived(loading || saving || !loaded || !hasChanges);

  function isCurrentLoad(loadToken: ProjectLoadToken): boolean {
    return isCurrentProjectLoad(loadToken, projectRef, loadRevision);
  }

  async function fetchSessionConfig(ref: string): Promise<ConfigFetchResult> {
    try {
      const response = await apiClient(`/v1/projects/${encodeURIComponent(ref)}/config/auth`);
      const payload = await readAuthApiPayload(response);
      if (response.ok) return { ok: true, nextDraft: parseSessionConfigResponse(payload) };
      return {
        ok: false,
        message: authApiResponseMessage(payload, `加载失败（${response.status}）`),
        managedBoundary: response.status === 409 ? parseAuthManagedBoundary(payload) : null,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        managedBoundary: null,
      };
    }
  }

  function applyLoadedDraft(nextDraft: SessionDraft): void {
    draft = nextDraft;
    initialDraft = cloneSessionDraft(nextDraft);
    loaded = true;
    managedBoundary = null;
  }

  async function loadConfig(ref: string): Promise<void> {
    loadRevision += 1;
    const loadToken = createProjectLoadToken(ref, loadRevision);
    const projectChanged = stateProjectRef !== null && stateProjectRef !== ref;
    activeLoadToken = loadToken;
    stateProjectRef = ref;
    loading = true;
    saving = false;
    loaded = false;
    errorMessage = null;
    managedBoundary = null;
    formError = null;
    successMessage = null;
    if (projectChanged) {
      draft = emptySessionDraft();
      initialDraft = emptySessionDraft();
      applyWarning = null;
    }
    const configResult = await fetchSessionConfig(ref);
    if (!isCurrentLoad(loadToken)) return;
    if (configResult.ok) applyLoadedDraft(configResult.nextDraft);
    else {
      managedBoundary = configResult.managedBoundary;
      errorMessage = configResult.managedBoundary ? null : configResult.message;
    }
    loading = false;
  }

  function applyConfigReadBack(configResult: ConfigFetchResult): void {
    if (configResult.ok) {
      applyLoadedDraft(configResult.nextDraft);
      return;
    }
    if (configResult.managedBoundary) {
      managedBoundary = configResult.managedBoundary;
      loaded = false;
    }
  }

  function configReadBackError(configResult: ConfigFetchResult): string | null {
    return configResult.ok ? null : configResult.message;
  }

  async function persistSessionPatch(
    patch: JsonObject,
    ref: string,
    loadToken: ProjectLoadToken,
  ): Promise<void> {
    const response = await apiClient(`/v1/projects/${encodeURIComponent(ref)}/config/auth`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await readAuthApiPayload(response);
    if (!isCurrentLoad(loadToken)) return;
    const saveDirective = resolveSessionSaveDirective({ ok: response.ok, status: response.status, payload });
    if (!saveDirective.requiresReadBack) {
      errorMessage = saveDirective.message;
      return;
    }
    const configResult = await fetchSessionConfig(ref);
    if (!isCurrentLoad(loadToken)) return;
    applyConfigReadBack(configResult);
    const readBackError = configReadBackError(configResult);
    if (saveDirective.kind === "applied") {
      applyWarning = null;
      if (readBackError) errorMessage = `配置已保存并应用，但回读失败：${readBackError}`;
      else successMessage = "会话策略已保存并应用到 GoTrue。";
      return;
    }
    applyWarning = readBackError
      ? { ...saveDirective.warning, readBackError }
      : saveDirective.warning;
  }

  async function saveConfig(): Promise<void> {
    const ref = projectRef;
    const loadToken = activeLoadToken;
    if (!loadToken || !isCurrentLoad(loadToken)) return;
    formError = null;
    errorMessage = null;
    successMessage = null;
    let patch: JsonObject;
    try {
      patch = buildSessionPolicyPatch(draft, initialDraft);
    } catch (error) {
      if (error instanceof SessionPolicyInputError) {
        formError = error.message;
        return;
      }
      throw error;
    }
    if (Object.keys(patch).length === 0) return;

    saving = true;
    try {
      await persistSessionPatch(patch, ref, loadToken);
    } catch (error) {
      if (isCurrentLoad(loadToken)) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (isCurrentLoad(loadToken)) saving = false;
    }
  }

  $effect(() => {
    const ref = projectRef;
    if (ref) void loadConfig(ref);
  });
</script>

<div class="flex h-full flex-col space-y-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">会话管理</h1>
      <p class="mt-1 text-sm text-muted-foreground">从项目认证配置读取并更新 JWT 与 Refresh Token 生命周期。</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <button
        class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs hover:bg-muted/50 disabled:opacity-50"
        onclick={() => loadConfig(projectRef)}
        disabled={loading || saving}
      >
        <RefreshCw size={13} class={loading ? "animate-spin" : ""} />
        刷新
      </button>
      <button
        class="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand/90 disabled:opacity-50"
        onclick={saveConfig}
        disabled={saveDisabled}
      >
        {#if saving}<Loader2 size={13} class="animate-spin" />{:else}<Save size={13} />{/if}
        保存配置
      </button>
    </div>
  </div>

  {#if errorMessage}
    <div class="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/5 px-4 py-3 text-sm text-red-700">
      <AlertTriangle size={15} class="mt-0.5 shrink-0" />
      <div class="flex-1">
        <div class="font-medium">无法读取或应用认证配置</div>
        <div class="mt-0.5 text-xs">{errorMessage}</div>
      </div>
      <button class="text-xs underline" onclick={() => loadConfig(projectRef)} disabled={loading || saving}>重试</button>
    </div>
  {/if}

  {#if formError}
    <div class="rounded-lg border border-red-500/25 bg-red-500/5 px-4 py-3 text-xs text-red-700">{formError}</div>
  {/if}

  {#if successMessage}
    <div class="flex items-center gap-2 rounded-lg border border-green-500/25 bg-green-500/5 px-4 py-3 text-xs text-green-700">
      <CheckCircle2 size={15} />{successMessage}
    </div>
  {/if}

  {#if applyWarning}
    <div class="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-900">
      <div class="flex items-center gap-2 font-semibold"><AlertTriangle size={15} />配置已保存，但运行时尚未完全应用</div>
      <p class="mt-1">{applyWarning.message}</p>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span>代码：<code>{applyWarning.code}</code></span>
        <span>当前运行时：{applyWarning.runtimeApplied === null ? "未知" : applyWarning.runtimeApplied ? "已应用" : "未应用"}</span>
        {#if applyWarning.dependentStatus !== null}
          <span>依赖项目：{dependentStatusLabel(applyWarning.dependentStatus)}</span>
        {:else if applyWarning.dependentsApplied !== null}
          <span>依赖项目：{applyWarning.dependentsApplied ? "已刷新" : "未完全应用"}</span>
        {/if}
        {#if applyWarning.authorityProjectRef}<span>Auth owner：<code>{applyWarning.authorityProjectRef}</code></span>{/if}
      </div>
      {#if applyWarning.failedDependents.length > 0}
        <p class="mt-2">失败依赖：{applyWarning.failedDependents.join("、")}</p>
      {/if}
      {#if applyWarning.readBackError}
        <p class="mt-2 text-red-700">已持久化配置回读失败：{applyWarning.readBackError}</p>
      {/if}
    </div>
  {/if}

  {#if loading && !loaded}
    <div class="flex flex-1 items-center justify-center"><Loader2 size={30} class="animate-spin text-brand opacity-50" /></div>
  {:else if !loaded}
    <div class="rounded-xl border bg-card p-6">
      {#if managedBoundary}
        <div class="flex items-start gap-3">
          <Shield size={20} class="mt-0.5 shrink-0 text-amber-700" />
          <div>
            <h2 class="font-semibold">认证配置由 SupAuth owner 管理</h2>
            <p class="mt-1 text-sm text-muted-foreground">{managedBoundary.message}</p>
            <div class="mt-3 space-y-1 text-xs">
              <div>Authority project：<code>{managedBoundary.authorityProjectRef}</code></div>
              {#if managedBoundary.ownerManagementPath}<div>Backend management path：<code>{managedBoundary.ownerManagementPath}</code></div>{/if}
            </div>
            <a class="mt-4 inline-flex rounded-lg border px-3 py-2 text-xs hover:bg-muted/50" href={`/project/${encodeURIComponent(managedBoundary.authorityProjectRef)}/auth/sessions`}>
              前往 owner 会话配置
            </a>
          </div>
        </div>
      {:else}
        <div class="text-sm text-muted-foreground">认证配置当前不可用。请先解决上方错误后重试；未成功加载前不会开放编辑。</div>
      {/if}
    </div>
  {:else}
    <div class="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-800">
      修改会话策略会影响后续登录和 Refresh Token 请求。未从服务端返回的字段显示为“不可用”，不会被保存时猜测或覆盖。
    </div>

    <fieldset class="grid gap-3 lg:grid-cols-2" disabled={saving}>
      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Clock size={16} /></div>
          <div><h2 class="text-sm font-semibold">Access Token</h2><p class="text-[10px] text-muted-foreground">GoTrue 签发的 JWT 有效期。</p></div>
        </div>
        <label class="block text-xs font-medium">JWT 有效期（秒）
          <input
            class="mt-2 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-brand"
            type="text" inputmode="numeric" placeholder="不可用；填写后设置"
            bind:value={draft.jwtExpiry} oninput={() => formError = null}
          />
        </label>
        <p class="mt-2 text-[10px] text-muted-foreground">当前：{draft.jwtExpiry ? formatSessionSeconds(draft.jwtExpiry) : "不可用"}</p>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><RefreshCw size={16} /></div>
          <div><h2 class="text-sm font-semibold">Refresh Token 轮换</h2><p class="text-[10px] text-muted-foreground">每次刷新是否签发新的 Refresh Token。</p></div>
        </div>
        <select class="w-full rounded-lg border bg-background px-3 py-2 text-sm" bind:value={draft.rotationEnabled} onchange={() => formError = null}>
          <option value="">不可用（服务端未返回）</option>
          <option value="true">已启用</option>
          <option value="false">已禁用</option>
        </select>
        <p class="mt-2 text-[10px] text-muted-foreground">旧版本响应的 security_refresh_token_rotation_enabled 也会被兼容读取。</p>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Timer size={16} /></div>
          <div><h2 class="text-sm font-semibold">Refresh Token 重用窗口</h2><p class="text-[10px] text-muted-foreground">允许同一 Refresh Token 重试的时间窗口。</p></div>
        </div>
        <label class="block text-xs font-medium">窗口（秒）
          <input
            class="mt-2 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-brand"
            type="text" inputmode="numeric" placeholder="不可用；填写后设置"
            bind:value={draft.reuseInterval} oninput={() => formError = null}
          />
        </label>
        <p class="mt-2 text-[10px] text-muted-foreground">当前：{draft.reuseInterval ? formatSessionSeconds(draft.reuseInterval) : "不可用"}</p>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Shield size={16} /></div>
          <div><h2 class="text-sm font-semibold">单用户会话</h2><p class="text-[10px] text-muted-foreground">限制每个用户同时保持一个活跃会话。</p></div>
        </div>
        <select class="w-full rounded-lg border bg-background px-3 py-2 text-sm" bind:value={draft.singlePerUser} onchange={() => formError = null}>
          <option value="">不可用（服务端未返回）</option>
          <option value="true">已启用</option>
          <option value="false">已禁用</option>
        </select>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Clock size={16} /></div>
          <div><h2 class="text-sm font-semibold">非活动超时</h2><p class="text-[10px] text-muted-foreground">用户无活动时自动结束会话。</p></div>
        </div>
        <select class="w-full rounded-lg border bg-background px-3 py-2 text-sm" bind:value={draft.inactivityMode} onchange={() => formError = null}>
          <option value="unavailable">不可用（服务端未返回）</option>
          <option value="disabled">未启用</option>
          <option value="enabled">启用</option>
        </select>
        {#if draft.inactivityMode === "enabled"}
          <input class="mt-2 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm" type="text" inputmode="decimal" placeholder="秒" bind:value={draft.inactivityTimeout} oninput={() => formError = null} />
        {/if}
        <p class="mt-2 text-[10px] text-muted-foreground">当前：{draft.inactivityMode === "enabled" ? formatSessionSeconds(draft.inactivityTimeout) : draft.inactivityMode === "disabled" ? "未启用" : "不可用"}</p>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Clock size={16} /></div>
          <div><h2 class="text-sm font-semibold">会话总时长</h2><p class="text-[10px] text-muted-foreground">无论是否活动，单个会话允许持续的最长时间。</p></div>
        </div>
        <select class="w-full rounded-lg border bg-background px-3 py-2 text-sm" bind:value={draft.timeboxMode} onchange={() => formError = null}>
          <option value="unavailable">不可用（服务端未返回）</option>
          <option value="disabled">未启用</option>
          <option value="enabled">启用</option>
        </select>
        {#if draft.timeboxMode === "enabled"}
          <input class="mt-2 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm" type="text" inputmode="decimal" placeholder="秒" bind:value={draft.timebox} oninput={() => formError = null} />
        {/if}
        <p class="mt-2 text-[10px] text-muted-foreground">当前：{draft.timeboxMode === "enabled" ? formatSessionSeconds(draft.timebox) : draft.timeboxMode === "disabled" ? "未启用" : "不可用"}</p>
      </section>
    </fieldset>
  {/if}
</div>
