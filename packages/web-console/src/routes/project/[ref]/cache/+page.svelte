<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { onMount } from "svelte";
  import {
    AlertTriangle,
    CheckCircle2,
    Clock3,
    Code2,
    Loader2,
    MemoryStick,
    RefreshCw,
    Trash2,
  } from "lucide-svelte";
  import { t } from "svelte-i18n";
  import { toast } from "svelte-sonner";

  type CacheOperation = "get" | "set" | "delete" | "ttl" | "getset" | "getdel";

  type ProjectCacheStatus = {
    projectRef: string;
    configured: boolean;
    active: boolean;
    configurationCurrent: boolean;
    leases: number;
    lastUsedAt: string | null;
  };

  const projectRef = $derived(page.params.ref ?? "");
  let status = $state<ProjectCacheStatus | null>(null);
  let operation = $state<CacheOperation>("get");
  const requiresValue = $derived(operation === "set" || operation === "getset");
  let key = $state("");
  let valueInput = $state("{}");
  let ttlInput = $state("");
  let operationResult = $state<unknown>(null);
  let hasResult = $state(false);
  let confirmation = $state("");
  let loading = $state(true);
  let refreshing = $state(false);
  let executing = $state(false);
  let flushing = $state(false);
  let loadError = $state<string | null>(null);

  async function readPayload(response: Response): Promise<Record<string, unknown>> {
    const value: unknown = await response.json().catch(() => ({}));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  function responseMessage(payload: Record<string, unknown>, fallback: string) {
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
    return fallback;
  }

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : $t("Cache.request_failed");
  }

  function formatJson(jsonValue: unknown) {
    return JSON.stringify(jsonValue, null, 2) ?? "null";
  }

  function formatDate(value: string | null) {
    return value ? new Date(value).toLocaleString() : $t("Cache.never_used");
  }

  async function loadStatus(silent = false) {
    if (silent) refreshing = true;
    else {
      loading = true;
      loadError = null;
    }
    try {
      const response = await apiClient(`/v1/projects/${encodeURIComponent(projectRef)}/cache`);
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(responseMessage(payload, $t("Cache.request_failed")));
      status = payload as unknown as ProjectCacheStatus;
      if (!status.configurationCurrent && !refreshing) void refreshConfiguration();
    } catch (error) {
      const message = errorMessage(error);
      if (!silent) loadError = message;
      toast.error(message);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refreshConfiguration() {
    if (refreshing) return;
    refreshing = true;
    try {
      await postCacheRequest("refresh", {});
      await loadStatus(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      refreshing = false;
    }
  }

  function buildOperationPayload() {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error($t("Cache.key_required"));
    }

    const requestPayload: Record<string, unknown> = { op: operation, key: normalizedKey };
    if (requiresValue) {
      try {
        requestPayload.value = JSON.parse(valueInput);
      } catch {
        throw new Error($t("Cache.invalid_json"));
      }
    }
    if (operation === "set" && ttlInput.trim()) {
      const ttl = Number(ttlInput);
      if (!Number.isSafeInteger(ttl) || ttl < 0) {
        throw new Error($t("Cache.invalid_ttl"));
      }
      requestPayload.ttl_ms = ttl;
    }
    return requestPayload;
  }

  async function postCacheRequest(pathSuffix: string, requestPayload: Record<string, unknown>) {
    const response = await apiClient(
      `/v1/projects/${encodeURIComponent(projectRef)}/cache/${pathSuffix}`,
      { method: "POST", body: JSON.stringify(requestPayload) },
    );
    const responsePayload = await readPayload(response);
    if (!response.ok) throw new Error(responseMessage(responsePayload, $t("Cache.request_failed")));
    return responsePayload;
  }

  async function executeOperation() {
    let requestPayload: Record<string, unknown>;
    try {
      requestPayload = buildOperationPayload();
    } catch (error) {
      toast.error(errorMessage(error));
      return;
    }
    executing = true;
    try {
      const responsePayload = await postCacheRequest("operations", requestPayload);
      operationResult = responsePayload;
      hasResult = true;
      toast.success($t("Cache.operation_success"));
      await loadStatus(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      executing = false;
    }
  }

  async function flushProjectCache() {
    if (confirmation !== projectRef) return;
    if (!window.confirm($t("Cache.flush_confirm", { values: { projectRef } }))) return;

    flushing = true;
    try {
      const responsePayload = await postCacheRequest("flush", { confirmation: projectRef });
      const deleted = typeof responsePayload.deleted === "number" ? responsePayload.deleted : 0;
      confirmation = "";
      operationResult = responsePayload;
      hasResult = true;
      toast.success($t("Cache.flush_success", { values: { count: deleted } }));
      await loadStatus(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      flushing = false;
    }
  }

  onMount(() => {
    void loadStatus();
  });
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex items-center gap-2">
        <MemoryStick class="h-6 w-6 text-brand" />
        <h1 class="text-2xl font-bold">{$t("Cache.title")}</h1>
      </div>
      <p class="mt-1 text-sm text-muted-foreground">{$t("Cache.project_subtitle")}</p>
    </div>
    <button
      type="button"
      onclick={() => status && !status.configurationCurrent ? void refreshConfiguration() : void loadStatus(true)}
      disabled={refreshing}
      class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
    >
      <RefreshCw class={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      {$t("Cache.refresh")}
    </button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center gap-2 rounded-xl border bg-card py-16 text-sm text-muted-foreground">
      <Loader2 class="h-5 w-5 animate-spin" />
      {$t("Cache.loading")}
    </div>
  {:else if loadError}
    <div class="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 h-5 w-5 shrink-0" />
      <span>{loadError}</span>
    </div>
  {:else if status}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div class="rounded-xl border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{$t("Cache.data_plane")}</p>
        <div class="mt-3 flex items-center gap-2 text-lg font-semibold">
          {#if status.configured}<CheckCircle2 class="h-5 w-5 text-emerald-500" />{:else}<AlertTriangle class="h-5 w-5 text-amber-500" />{/if}
          {status.configured ? $t("Cache.configured") : $t("Cache.not_configured")}
        </div>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{$t("Cache.active")}</p>
        <p class="mt-3 text-lg font-semibold">{status.active ? $t("Cache.active") : $t("Cache.inactive")}</p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{$t("Cache.leases")}</p>
        <p class="mt-3 text-lg font-semibold tabular-nums">{status.leases}</p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{$t("Cache.last_used")}</p>
        <div class="mt-3 flex items-center gap-2 text-sm font-semibold">
          <Clock3 class="h-4 w-4 text-muted-foreground" />
          {formatDate(status.lastUsedAt)}
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm {status.configurationCurrent ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300'}">
      <span>{status.configurationCurrent ? $t("Cache.config_current") : refreshing ? $t("Cache.config_syncing") : $t("Cache.config_stale")}</span>
      {#if !status.configurationCurrent}
        <button
          type="button"
          onclick={() => void refreshConfiguration()}
          disabled={refreshing}
          class="inline-flex items-center gap-2 rounded-md border border-current/20 px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-background/30 disabled:opacity-50"
        >
          <RefreshCw class={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          {$t("Cache.refresh")}
        </button>
      {/if}
    </div>
  {/if}

  <div class="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
    <section class="rounded-xl border bg-card p-5">
      <div class="flex items-start gap-3">
        <Code2 class="mt-0.5 h-5 w-5 text-brand" />
        <div>
          <h2 class="font-semibold">{$t("Cache.exact_key_title")}</h2>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{$t("Cache.exact_key_desc")}</p>
        </div>
      </div>

      <div class="mt-5 grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
        <label class="space-y-1.5 text-sm">
          <span class="font-medium">{$t("Cache.operation")}</span>
          <select bind:value={operation} class="w-full rounded-lg border bg-background px-3 py-2.5 font-mono text-sm">
            <option value="get">{$t("Cache.operation_get")}</option>
            <option value="set">{$t("Cache.operation_set")}</option>
            <option value="delete">{$t("Cache.operation_delete")}</option>
            <option value="ttl">{$t("Cache.operation_ttl")}</option>
            <option value="getset">{$t("Cache.operation_getset")}</option>
            <option value="getdel">{$t("Cache.operation_getdel")}</option>
          </select>
        </label>
        <label class="space-y-1.5 text-sm">
          <span class="font-medium">{$t("Cache.key")}</span>
          <input bind:value={key} maxlength="512" placeholder="session:user:42" class="w-full rounded-lg border bg-background px-3 py-2.5 font-mono text-sm" />
        </label>
      </div>

      {#if requiresValue}
        <label class="mt-4 block space-y-1.5 text-sm">
          <span class="font-medium">{$t("Cache.value_json")}</span>
          <textarea bind:value={valueInput} rows="7" spellcheck="false" class="w-full rounded-lg border bg-background px-3 py-2.5 font-mono text-sm"></textarea>
        </label>
      {/if}

      {#if operation === "set"}
        <label class="mt-4 block max-w-xs space-y-1.5 text-sm">
          <span class="font-medium">{$t("Cache.ttl_ms")}</span>
          <input bind:value={ttlInput} inputmode="numeric" placeholder="60000" class="w-full rounded-lg border bg-background px-3 py-2.5 font-mono text-sm" />
        </label>
      {/if}

      <button
        type="button"
        onclick={executeOperation}
        disabled={executing || !status?.configured}
        class="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
      >
        {#if executing}<Loader2 class="h-4 w-4 animate-spin" />{/if}
        {executing ? $t("Cache.executing") : $t("Cache.execute")}
      </button>
    </section>

    <section class="rounded-xl border bg-card p-5">
      <h2 class="font-semibold">{$t("Cache.result")}</h2>
      {#if hasResult}
        <pre class="mt-4 max-h-[420px] overflow-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100">{formatJson(operationResult)}</pre>
      {:else}
        <div class="mt-4 flex min-h-40 items-center justify-center rounded-lg border border-dashed px-6 text-center text-sm text-muted-foreground">
          {$t("Cache.no_result")}
        </div>
      {/if}
    </section>
  </div>

  <section class="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
    <div class="flex items-start gap-3">
      <Trash2 class="mt-0.5 h-5 w-5 text-destructive" />
      <div class="flex-1">
        <h2 class="font-semibold text-destructive">{$t("Cache.flush_title")}</h2>
        <p class="mt-1 text-sm leading-6 text-muted-foreground">{$t("Cache.flush_desc")}</p>
        <div class="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            bind:value={confirmation}
            aria-label={$t("Cache.confirmation")}
            placeholder={$t("Cache.confirmation_placeholder", { values: { projectRef } })}
            class="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2.5 font-mono text-sm"
          />
          <button
            type="button"
            onclick={flushProjectCache}
            disabled={flushing || confirmation !== projectRef || !status?.configured}
            class="inline-flex items-center justify-center gap-2 rounded-lg bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {#if flushing}<Loader2 class="h-4 w-4 animate-spin" />{/if}
            {flushing ? $t("Cache.flushing") : $t("Cache.flush")}
          </button>
        </div>
      </div>
    </div>
  </section>
</div>
