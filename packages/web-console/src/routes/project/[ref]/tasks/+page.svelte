<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
  import { toast } from "svelte-sonner";
  import { Loader2, RefreshCw, RotateCcw, XCircle, Settings2, ArrowLeft } from "lucide-svelte";
  import {
    backgroundSettingLimits,
    canCancelTask,
    canRetryTask,
    equalBackgroundSettings,
    parseBackgroundReceipt,
    parseBackgroundSettings,
    parseTaskDetail,
    parseTaskList,
    parseTaskMutation,
    parseTaskNotification,
    requestTaskCenter,
    validTaskProjectRef,
    type BackgroundDraft,
    type BackgroundSettings,
    type TaskDetail,
    type TaskRecord,
  } from "$lib/task-center";

  const settingKeys = Object.keys(backgroundSettingLimits) as (keyof BackgroundSettings)[];

  const statusKeys: Record<string, string> = {
    pending: "pending", leased: "leased", running: "running", retry_scheduled: "retry_scheduled",
    succeeded: "succeeded", failed: "failed", dead_lettered: "dead_lettered", cancelled: "cancelled",
  };

  const projectRef = $derived(page.params.ref);

  let tasks = $state<TaskRecord[]>([]);
  let listError = $state(false);
  let loading = $state(false);
  let activeTab = $state<"tasks" | "dlq" | "settings">("tasks");

  let settings = $state<BackgroundSettings | null>(null);
  let settingsError = $state(false);
  let draft = $state<BackgroundDraft>(emptyDraft());
  let savingSettings = $state(false);

  let selected = $state<TaskDetail | null>(null);
  let selectedId = $state<string | null>(null);
  let selectedError = $state(false);
  let selectedLoading = $state(false);
  let mutating = $state(false);
  let detailStale = false;

  let projectScope = 0;
  let listController: AbortController | null = null;
  let settingsController: AbortController | null = null;
  let detailController: AbortController | null = null;
  let socket: WebSocket | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  function emptyDraft(): BackgroundDraft {
    return {
      concurrency: undefined, max_attempts: undefined, max_payload_bytes: undefined,
      timeout_sec_default: undefined, timeout_sec_max: undefined,
    };
  }
  function draftFrom(settingsValue: BackgroundSettings): BackgroundDraft {
    return {
      concurrency: settingsValue.concurrency, max_attempts: settingsValue.max_attempts,
      max_payload_bytes: settingsValue.max_payload_bytes,
      timeout_sec_default: settingsValue.timeout_sec_default, timeout_sec_max: settingsValue.timeout_sec_max,
    };
  }
  function draftValid(): boolean {
    for (const key of settingKeys) {
      const value = draft[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
      const limit = backgroundSettingLimits[key];
      if (value < limit.min || value > limit.max) return false;
    }
    return (draft.timeout_sec_default ?? 0) <= (draft.timeout_sec_max ?? 0);
  }
  const canSave = $derived(
    !savingSettings && settings !== null && draftValid() && !equalBackgroundSettings(draft, settings),
  );

  function taskStatusLabel(status: string): string {
    const key = statusKeys[status];
    return key ? $t(`TaskCenter.status_${key}`) : status;
  }

  function current(scope: number): boolean {
    return scope === projectScope;
  }

  function listUrl(ref: string, dlq: boolean): string {
    return `/v1/projects/${ref}/tasks?summary=true${dlq ? "&dlq=true" : ""}`;
  }
  function detailUrl(ref: string, id: string): string {
    return `/v1/projects/${ref}/tasks/${id}`;
  }

  function loadList(ref: string, scope: number, dlq = false) {
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    loading = true;
    void requestTaskCenter(listUrl(ref, dlq), apiClient, (value) => parseTaskList(value, ref, dlq), { signal: controller.signal })
      .then((rows) => {
        if (!current(scope) || controller.signal.aborted) return;
        tasks = rows;
        listError = false;
        if (selectedId) {
          detailStale = true;
          if (!selectedLoading) loadDetail(ref, selectedId, scope);
        }
      })
      .catch(() => {
        if (!current(scope) || controller.signal.aborted) return;
        tasks = [];
        listError = true;
      })
      .finally(() => {
        if (current(scope) && !controller.signal.aborted) loading = false;
      });
  }

  function loadSettings(ref: string, scope: number) {
    settingsController?.abort();
    const controller = new AbortController();
    settingsController = controller;
    void requestTaskCenter(`/v1/projects/${ref}/tasks/settings/background`, apiClient, parseBackgroundSettings, { signal: controller.signal })
      .then((value) => {
        if (!current(scope) || controller.signal.aborted) return;
        settings = value;
        settingsError = false;
        draft = draftFrom(value);
      })
      .catch(() => {
        if (!current(scope) || controller.signal.aborted) return;
        settings = null;
        settingsError = true;
        draft = emptyDraft();
      });
  }

  function loadDetail(ref: string, id: string, scope: number) {
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    selectedLoading = true;
    detailStale = false;
    void requestTaskCenter(detailUrl(ref, id), apiClient, (value) => parseTaskDetail(value, ref, id), { signal: controller.signal })
      .then((value) => {
        if (!current(scope) || controller.signal.aborted) return;
        selected = value;
        selectedError = false;
      })
      .catch(() => {
        if (!current(scope) || controller.signal.aborted) return;
        selectedError = true;
      })
      .finally(() => {
        if (!current(scope) || controller.signal.aborted) return;
        selectedLoading = false;
        if (detailStale && selectedId === id) loadDetail(ref, id, scope);
      });
  }

  function selectTask(id: string) {
    const ref = projectRef;
    if (!ref) return;
    selectedId = id;
    loadDetail(ref, id, projectScope);
  }

  function scheduleRefresh(ref: string, scope: number) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (current(scope)) loadList(ref, scope, activeTab === "dlq");
    }, 250);
  }

  function connectSocket(ref: string, scope: number) {
    socket?.close();
    socket = null;
    if (!validTaskProjectRef(ref)) return;
    let url = `/v1/projects/${ref}/tasks/stream`;
    try {
      const absolute = new URL(url, page.url ?? "http://localhost/");
      absolute.protocol = absolute.protocol === "https:" ? "wss:" : "ws:";
      url = absolute.toString();
    } catch { /* Fall back to the relative path. */ }
    const next = new WebSocket(url);
    socket = next;
    next.onopen = () => { if (current(scope)) scheduleRefresh(ref, scope); };
    next.onmessage = (event: MessageEvent<unknown>) => {
      if (!current(scope)) return;
      if (parseTaskNotification(event.data, ref)) scheduleRefresh(ref, scope);
    };
  }

  function refresh() {
    const ref = projectRef;
    if (!ref) return;
    loadList(ref, projectScope, activeTab === "dlq");
  }

  $effect(() => {
    const ref = projectRef;
    projectScope += 1;
    const scope = projectScope;
    tasks = [];
    listError = false;
    loading = Boolean(ref);
    settings = null;
    settingsError = false;
    draft = emptyDraft();
    selected = null;
    selectedId = null;
    selectedError = false;
    selectedLoading = false;
    mutating = false;
    detailStale = false;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (!ref) {
      listController?.abort();
      settingsController?.abort();
      detailController?.abort();
      socket?.close();
      socket = null;
      return;
    }
    loadList(ref, scope);
    loadSettings(ref, scope);
    connectSocket(ref, scope);
    return () => {
      listController?.abort();
      settingsController?.abort();
      detailController?.abort();
      socket?.close();
      socket = null;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    };
  });

  async function saveSettings() {
    const ref = projectRef;
    if (!ref || !canSave || !settings) return;
    const scope = projectScope;
    const submitted: BackgroundSettings = {
      concurrency: draft.concurrency ?? 0, max_attempts: draft.max_attempts ?? 0,
      max_payload_bytes: draft.max_payload_bytes ?? 0,
      timeout_sec_default: draft.timeout_sec_default ?? 0, timeout_sec_max: draft.timeout_sec_max ?? 0,
    };
    savingSettings = true;
    try {
      const receipt = await requestTaskCenter(
        `/v1/projects/${ref}/tasks/settings/background`, apiClient,
        (value) => parseBackgroundReceipt(value, submitted),
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submitted) },
      );
      if (!current(scope)) return;
      settings = receipt;
      draft = draftFrom(receipt);
      toast.success($t("TaskCenter.save_settings_success"));
    } catch {
      if (current(scope)) toast.error($t("TaskCenter.save_settings_failed"));
    } finally {
      savingSettings = false;
    }
  }

  async function retryTask() {
    const ref = projectRef;
    const task = selected;
    if (!ref || !task || mutating || !canRetryTask(task)) return;
    const scope = projectScope;
    mutating = true;
    try {
      await requestTaskCenter(
        `/v1/projects/${ref}/tasks/${task.id}/retry`, apiClient,
        (value) => parseTaskMutation(value, ref, task.id, "retry"),
        { method: "POST" },
      );
    } catch {
      if (current(scope)) toast.error($t("TaskCenter.retry_failed"));
    } finally {
      mutating = false;
    }
  }

  async function cancelTask() {
    const ref = projectRef;
    const task = selected;
    if (!ref || !task || mutating || !canCancelTask(task)) return;
    const scope = projectScope;
    mutating = true;
    try {
      const result = await requestTaskCenter(
        `/v1/projects/${ref}/tasks/${task.id}/cancel`, apiClient,
        (value) => parseTaskMutation(value, ref, task.id, "cancel"),
        { method: "POST" },
      );
      if (!current(scope)) return;
      if (selected) selected = { ...selected, ...result };
      toast.success($t("TaskCenter.cancel_requested"));
    } catch {
      if (current(scope)) toast.error($t("TaskCenter.cancel_failed"));
    } finally {
      mutating = false;
    }
  }
</script>

<div class="flex flex-col gap-4 p-4">
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-1">
      <button
        class="rounded-lg px-3 py-1.5 text-sm {activeTab === 'tasks' ? 'bg-foreground text-background' : 'border hover:bg-muted/50'}"
        onclick={() => { activeTab = "tasks"; refresh(); }}
      >{$t("TaskCenter.all_tasks")}</button>
      <button
        class="rounded-lg px-3 py-1.5 text-sm {activeTab === 'dlq' ? 'bg-foreground text-background' : 'border hover:bg-muted/50'}"
        onclick={() => { activeTab = "dlq"; refresh(); }}
      >{$t("TaskCenter.dead_letter_queue")}</button>
      <button
        class="rounded-lg px-3 py-1.5 text-sm {activeTab === 'settings' ? 'bg-foreground text-background' : 'border hover:bg-muted/50'}"
        onclick={() => { activeTab = "settings"; }}
      >{$t("TaskCenter.background_settings")}</button>
    </div>
    <button
      aria-label="Refresh"
      onclick={refresh}
      disabled={loading}
      class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-muted/50 disabled:opacity-50"
    >
      {#if loading}<Loader2 size={14} class="animate-spin" />{:else}<RefreshCw size={14} />{/if}
      {$t("Common.refresh")}
    </button>
  </div>

  {#if listError}
    <div role="alert" class="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600">
      {$t("TaskCenter.list_failed")}
    </div>
  {/if}

  {#if activeTab === "settings"}
    <div class="rounded-xl border bg-card p-4">
      {#if settingsError}
        <div role="alert" class="text-sm text-destructive">{$t("TaskCenter.settings_failed")}</div>
      {:else if settings}
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label class="space-y-1">
            <span class="text-xs font-medium">{$t("TaskCenter.concurrency")}</span>
            <input type="number" bind:value={draft.concurrency} disabled={savingSettings} class="w-full rounded-lg border px-3 py-2 text-sm" />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">{$t("TaskCenter.max_attempts")}</span>
            <input type="number" bind:value={draft.max_attempts} disabled={savingSettings} class="w-full rounded-lg border px-3 py-2 text-sm" />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">{$t("TaskCenter.default_timeout")}</span>
            <input type="number" bind:value={draft.timeout_sec_default} disabled={savingSettings} class="w-full rounded-lg border px-3 py-2 text-sm" />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">{$t("TaskCenter.max_timeout")}</span>
            <input type="number" bind:value={draft.timeout_sec_max} disabled={savingSettings} class="w-full rounded-lg border px-3 py-2 text-sm" />
          </label>
          <label class="space-y-1 md:col-span-2">
            <span class="text-xs font-medium">{$t("TaskCenter.max_payload")}</span>
            <input type="number" bind:value={draft.max_payload_bytes} disabled={savingSettings} class="w-full rounded-lg border px-3 py-2 text-sm" />
          </label>
        </div>
      {/if}
      <div class="mt-4 flex justify-end">
        <button
          onclick={saveSettings}
          disabled={!canSave}
          class="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          {#if savingSettings}<Loader2 size={14} class="animate-spin" />{:else}<Settings2 size={14} />{/if}
          {$t("TaskCenter.save_settings")}
        </button>
      </div>
    </div>
  {:else}
    {#if !listError}
    <div class="rounded-xl border bg-card overflow-hidden">
      <table class="w-full text-left text-sm">
        <thead class="bg-muted/30 text-xs uppercase text-muted-foreground">
          <tr>
            <th class="px-3 py-2">ID</th>
            <th class="px-3 py-2">Type</th>
            <th class="px-3 py-2">Status</th>
            <th class="px-3 py-2">Attempt</th>
          </tr>
        </thead>
        <tbody>
          {#each tasks as task (task.id)}
            <tr
              class="cursor-pointer border-t hover:bg-muted/20 {selected?.id === task.id ? 'bg-muted/30' : ''}"
              onclick={() => selectTask(task.id)}
            >
              <td class="px-3 py-2 font-mono text-xs">{task.id}</td>
              <td class="px-3 py-2 text-xs">{task.task_type}</td>
              <td class="px-3 py-2">
                <span title={task.status} class="text-xs font-medium">{taskStatusLabel(task.status)}</span>
              </td>
              <td class="px-3 py-2 text-xs">{task.attempt}/{task.max_attempts}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if tasks.length === 0 && !loading}
        <div class="p-6 text-center text-sm text-muted-foreground">{$t("TaskCenter.no_tasks")}</div>
      {/if}
    </div>
    {/if}

    {#if selected}
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center justify-between">
          <span class="font-mono text-xs">{selected.id}</span>
          <span title={selected.status} class="text-xs font-medium">{taskStatusLabel(selected.status)}</span>
        </div>
        {#if selectedError}
          <div role="alert" class="mt-2 text-xs text-destructive">{$t("TaskCenter.detail_failed")}</div>
        {/if}
        <div class="mt-3 flex gap-2">
          <button
            onclick={retryTask}
            disabled={mutating || !canRetryTask(selected)}
            class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          >
            <RotateCcw size={14} />{$t("TaskCenter.retry")}
          </button>
          <button
            onclick={cancelTask}
            disabled={mutating || !canCancelTask(selected)}
            class="inline-flex items-center gap-1.5 rounded-lg border border-destructive px-3 py-1.5 text-xs font-semibold text-destructive disabled:opacity-50"
          >
            <XCircle size={14} />{$t("TaskCenter.cancel_task")}
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>