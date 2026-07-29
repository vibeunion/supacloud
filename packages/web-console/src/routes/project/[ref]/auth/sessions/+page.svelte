<script lang="ts">
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
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
    emptySessionDraft,
    formatSessionSeconds,
    parseAuthManagedBoundary,
    parseSessionConfigResponse,
    resolveSessionSaveDirective,
    SessionPolicyInputError,
    type AuthApplyWarning,
    type AuthManagedBoundary,
    type DependentStatus,
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

  function dependentStatusLabel(status: DependentStatus): string {
    if (status === "applied") return $t("AuthSessions.dependent_status_applied");
    if (status === "failed") return $t("AuthSessions.dependent_status_failed");
    return $t("AuthSessions.dependent_status_unknown");
  }

  function runtimeAppliedLabel(applied: boolean | null): string {
    if (applied === null) return $t("AuthSessions.runtime_unknown");
    return applied ? $t("AuthSessions.runtime_applied") : $t("AuthSessions.runtime_not_applied");
  }

  function dependentsAppliedLabel(applied: boolean): string {
    return applied ? $t("AuthSessions.dependents_refreshed") : $t("AuthSessions.dependents_not_fully_applied");
  }

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
        message: authApiResponseMessage(payload, $t("AuthSessions.load_failed", { values: { status: response.status } })),
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
      if (readBackError) errorMessage = $t("AuthSessions.save_applied_readback_failed", { values: { error: readBackError } });
      else successMessage = $t("AuthSessions.save_applied");
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
      <h1 class="text-2xl font-bold">{$t("AuthSessions.title")}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{$t("AuthSessions.subtitle")}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <button
        class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs hover:bg-muted/50 disabled:opacity-50"
        onclick={() => loadConfig(projectRef)}
        disabled={loading || saving}
      >
        <RefreshCw size={13} class={loading ? "animate-spin" : ""} />
        {$t("AuthSessions.refresh")}
      </button>
      <button
        class="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand/90 disabled:opacity-50"
        onclick={saveConfig}
        disabled={saveDisabled}
      >
        {#if saving}<Loader2 size={13} class="animate-spin" />{:else}<Save size={13} />{/if}
        {$t("AuthSessions.save")}
      </button>
    </div>
  </div>

  {#if errorMessage}
    <div class="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/5 px-4 py-3 text-sm text-red-700">
      <AlertTriangle size={15} class="mt-0.5 shrink-0" />
      <div class="flex-1">
        <div class="font-medium">{$t("AuthSessions.error_heading")}</div>
        <div class="mt-0.5 text-xs">{errorMessage}</div>
      </div>
      <button class="text-xs underline" onclick={() => loadConfig(projectRef)} disabled={loading || saving}>{$t("AuthSessions.retry")}</button>
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
      <div class="flex items-center gap-2 font-semibold"><AlertTriangle size={15} />{$t("AuthSessions.partial_apply_title")}</div>
      <p class="mt-1">{applyWarning.message}</p>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span>{$t("AuthSessions.warning_code")}: <code>{applyWarning.code}</code></span>
        <span>{$t("AuthSessions.warning_runtime")}: {runtimeAppliedLabel(applyWarning.runtimeApplied)}</span>
        {#if applyWarning.dependentStatus !== null}
          <span>{$t("AuthSessions.warning_dependents")}: {dependentStatusLabel(applyWarning.dependentStatus)}</span>
        {:else if applyWarning.dependentsApplied !== null}
          <span>{$t("AuthSessions.warning_dependents")}: {dependentsAppliedLabel(applyWarning.dependentsApplied)}</span>
        {/if}
        {#if applyWarning.authorityProjectRef}<span>Auth owner：<code>{applyWarning.authorityProjectRef}</code></span>{/if}
      </div>
      {#if applyWarning.failedDependents.length > 0}
        <p class="mt-2">{$t("AuthSessions.failed_dependents")}: {applyWarning.failedDependents.join($t("AuthSessions.failed_dependents_separator"))}</p>
      {/if}
      {#if applyWarning.readBackError}
        <p class="mt-2 text-red-700">{$t("AuthSessions.persisted_readback_failed")}: {applyWarning.readBackError}</p>
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
            <h2 class="font-semibold">{$t("AuthSessions.managed_by_owner")}</h2>
            <p class="mt-1 text-sm text-muted-foreground">{managedBoundary.message}</p>
            <div class="mt-3 space-y-1 text-xs">
              <div>Authority project：<code>{managedBoundary.authorityProjectRef}</code></div>
              {#if managedBoundary.ownerManagementPath}<div>Backend management path：<code>{managedBoundary.ownerManagementPath}</code></div>{/if}
            </div>
            <a class="mt-4 inline-flex rounded-lg border px-3 py-2 text-xs hover:bg-muted/50" href={`/project/${encodeURIComponent(managedBoundary.authorityProjectRef)}/auth/sessions`}>
              {$t("AuthSessions.go_to_owner_sessions")}
            </a>
          </div>
        </div>
      {:else}
        <div class="text-sm text-muted-foreground">{$t("AuthSessions.config_unavailable")}</div>
      {/if}
    </div>
  {:else}
    <div class="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-800">
      {$t("AuthSessions.policy_warning")}
    </div>

    <fieldset class="grid gap-3 lg:grid-cols-2" disabled={saving}>
      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Clock size={16} /></div>
          <div><h2 class="text-sm font-semibold">{$t("AuthSessions.access_token")}</h2><p class="text-[10px] text-muted-foreground">{$t("AuthSessions.access_token_description")}</p></div>
        </div>
        <label class="block text-xs font-medium">{$t("AuthSessions.jwt_expiry")}
          <input
            class="mt-2 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-brand"
            type="text" inputmode="numeric" placeholder={$t("AuthSessions.unavailable_input_placeholder")}
            bind:value={draft.jwtExpiry} oninput={() => formError = null}
          />
        </label>
        <p class="mt-2 text-[10px] text-muted-foreground">{$t("AuthSessions.current_value")}: {draft.jwtExpiry ? formatSessionSeconds(draft.jwtExpiry) : $t("AuthSessions.unavailable")}</p>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><RefreshCw size={16} /></div>
          <div><h2 class="text-sm font-semibold">{$t("AuthSessions.refresh_rotation")}</h2><p class="text-[10px] text-muted-foreground">{$t("AuthSessions.refresh_rotation_description")}</p></div>
        </div>
        <select class="w-full rounded-lg border bg-background px-3 py-2 text-sm" bind:value={draft.rotationEnabled} onchange={() => formError = null}>
          <option value="">{$t("AuthSessions.unavailable_server")}</option>
          <option value="true">{$t("AuthSessions.enabled")}</option>
          <option value="false">{$t("AuthSessions.disabled")}</option>
        </select>
        <p class="mt-2 text-[10px] text-muted-foreground">{$t("AuthSessions.legacy_rotation_compatibility")}</p>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Timer size={16} /></div>
          <div><h2 class="text-sm font-semibold">{$t("AuthSessions.refresh_reuse_window")}</h2><p class="text-[10px] text-muted-foreground">{$t("AuthSessions.refresh_reuse_window_description")}</p></div>
        </div>
        <label class="block text-xs font-medium">{$t("AuthSessions.reuse_window")}
          <input
            class="mt-2 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-brand"
            type="text" inputmode="numeric" placeholder={$t("AuthSessions.unavailable_input_placeholder")}
            bind:value={draft.reuseInterval} oninput={() => formError = null}
          />
        </label>
        <p class="mt-2 text-[10px] text-muted-foreground">{$t("AuthSessions.current_value")}: {draft.reuseInterval ? formatSessionSeconds(draft.reuseInterval) : $t("AuthSessions.unavailable")}</p>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Shield size={16} /></div>
          <div><h2 class="text-sm font-semibold">{$t("AuthSessions.single_session")}</h2><p class="text-[10px] text-muted-foreground">{$t("AuthSessions.single_session_description")}</p></div>
        </div>
        <select class="w-full rounded-lg border bg-background px-3 py-2 text-sm" bind:value={draft.singlePerUser} onchange={() => formError = null}>
          <option value="">{$t("AuthSessions.unavailable_server")}</option>
          <option value="true">{$t("AuthSessions.enabled")}</option>
          <option value="false">{$t("AuthSessions.disabled")}</option>
        </select>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Clock size={16} /></div>
          <div><h2 class="text-sm font-semibold">{$t("AuthSessions.inactivity_timeout")}</h2><p class="text-[10px] text-muted-foreground">{$t("AuthSessions.inactivity_timeout_description")}</p></div>
        </div>
        <select class="w-full rounded-lg border bg-background px-3 py-2 text-sm" bind:value={draft.inactivityMode} onchange={() => formError = null}>
          <option value="unavailable">{$t("AuthSessions.unavailable_server")}</option>
          <option value="disabled">{$t("AuthSessions.disabled")}</option>
          <option value="enabled">{$t("AuthSessions.enabled")}</option>
        </select>
        {#if draft.inactivityMode === "enabled"}
          <input class="mt-2 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm" type="text" inputmode="decimal" placeholder={$t("AuthSessions.seconds_placeholder")} bind:value={draft.inactivityTimeout} oninput={() => formError = null} />
        {/if}
        <p class="mt-2 text-[10px] text-muted-foreground">{$t("AuthSessions.current_value")}: {draft.inactivityMode === "enabled" ? formatSessionSeconds(draft.inactivityTimeout) : draft.inactivityMode === "disabled" ? $t("AuthSessions.disabled") : $t("AuthSessions.unavailable")}</p>
      </section>

      <section class="rounded-xl border bg-card p-5">
        <div class="mb-4 flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand"><Clock size={16} /></div>
          <div><h2 class="text-sm font-semibold">{$t("AuthSessions.timebox")}</h2><p class="text-[10px] text-muted-foreground">{$t("AuthSessions.timebox_description")}</p></div>
        </div>
        <select class="w-full rounded-lg border bg-background px-3 py-2 text-sm" bind:value={draft.timeboxMode} onchange={() => formError = null}>
          <option value="unavailable">{$t("AuthSessions.unavailable_server")}</option>
          <option value="disabled">{$t("AuthSessions.disabled")}</option>
          <option value="enabled">{$t("AuthSessions.enabled")}</option>
        </select>
        {#if draft.timeboxMode === "enabled"}
          <input class="mt-2 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm" type="text" inputmode="decimal" placeholder={$t("AuthSessions.seconds_placeholder")} bind:value={draft.timebox} oninput={() => formError = null} />
        {/if}
        <p class="mt-2 text-[10px] text-muted-foreground">{$t("AuthSessions.current_value")}: {draft.timeboxMode === "enabled" ? formatSessionSeconds(draft.timebox) : draft.timeboxMode === "disabled" ? $t("AuthSessions.disabled") : $t("AuthSessions.unavailable")}</p>
      </section>
    </fieldset>
  {/if}
</div>
