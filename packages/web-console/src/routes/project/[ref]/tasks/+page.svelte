<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { apiClient } from "$lib/api";
  import { onMount } from "svelte";
  import { untrack } from "svelte";
  import { t } from "svelte-i18n";
  import {
    Activity,
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    Clock3,
    Loader2,
    RefreshCw,
    RotateCcw,
    Save,
    Settings2,
    ShieldAlert,
    XCircle,
    Copy,
    Download,
    ExternalLink,
  } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import dayjs from "dayjs";

  const projectRef = $derived(page.params.ref);
  const routeFunctionSlug = $derived(page.url.searchParams.get("function_slug") ?? "");
  const routeTaskId = $derived(page.url.searchParams.get("task_id") ?? "");

  type TaskRecord = {
    id: string;
    task_type: string;
    status: string;
    error?: string | null;
    function_slug?: string | null;
    function_version?: string | null;
    attempt?: number;
    max_attempts?: number;
    created_at: string;
    updated_at: string;
    attempts?: AttemptRecord[];
    latest_logs?: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }>;
  };

  type AttemptRecord = {
    attempt_no: number;
    status: string;
    started_at: string;
    completed_at?: string | null;
    duration_ms?: number | null;
    error?: string | null;
    response_status?: number | null;
    logs?: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> | null;
  };

  type BackgroundSettings = {
    concurrency: number;
    max_attempts: number;
    max_payload_bytes: number;
    timeout_sec_default: number;
    timeout_sec_max: number;
  };

  const taskStatusKeys: Record<string, string> = {
    pending: "pending",
    leased: "leased",
    running: "running",
    retry_scheduled: "retry_scheduled",
    succeeded: "succeeded",
    failed: "failed",
    dead_lettered: "dead_lettered",
    cancelled: "cancelled",
  };

  let tasks = $state<TaskRecord[]>([]);
  let dlqTasks = $state<TaskRecord[]>([]);
  let selectedTask = $state<TaskRecord | null>(null);
  let backgroundSettings = $state<BackgroundSettings | null>(null);

  let isLoading = $state(true);
  let isRefreshing = $state(false);
  let isSavingSettings = $state(false);
  let isLoadingDetail = $state(false);
  let activeTab = $state<"all" | "dlq" | "settings">("all");
  let statusFilter = $state("");
  let functionSlugFilter = $state("");
  let liveStatus = $state<"connected" | "connecting" | "reconnecting" | "polling" | "disconnected">("connecting");
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let taskListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedTaskRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let shouldReconnect = true;
  let ws: WebSocket | null = null;
  let logFilter = $state<"all" | "stdout" | "stderr">("all");
  let logSearch = $state("");
  let autoScrollLogs = $state(true);
  let activeLogContainer = $state<HTMLDivElement | null>(null);

  let draftSettings = $state<BackgroundSettings | null>(null);

  function buildTaskPath(onlyDeadLettered = false) {
    const query = new URLSearchParams();
    query.set("summary", "true");
    if (onlyDeadLettered) query.set("dlq", "true");
    if (onlyDeadLettered) query.set("limit", "100");
    if (statusFilter) query.set("status", statusFilter);
    if (functionSlugFilter) query.set("function_slug", functionSlugFilter);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return `/v1/projects/${projectRef}/tasks${suffix}`;
  }

  async function fetchTasks(silent = false) {
    if (!silent) isLoading = true;
    else isRefreshing = true;

    try {
      const [tasksRes, dlqRes, settingsRes] = await Promise.all([
        apiClient(buildTaskPath()),
        apiClient(buildTaskPath(true)),
        apiClient(`/v1/projects/${projectRef}/tasks/settings/background`)
      ]);

      const [tasksData, dlqData, settingsData] = await Promise.all([
        tasksRes.json(),
        dlqRes.json(),
        settingsRes.json()
      ]);

      if (!tasksRes.ok) throw new Error(tasksData.message || $t("TaskCenter.load_tasks_failed"));
      if (!dlqRes.ok) throw new Error(dlqData.message || $t("TaskCenter.load_dlq_failed"));
      if (!settingsRes.ok) throw new Error(settingsData.message || $t("TaskCenter.load_settings_failed"));

      tasks = tasksData || [];
      dlqTasks = dlqData || [];
      backgroundSettings = settingsData;
      draftSettings = { ...settingsData };

      if (selectedTask) {
        const stillExists = [...tasks, ...dlqTasks].find((task) => task.id === selectedTask?.id);
        if (stillExists) {
          await fetchTaskDetail(stillExists.id, true);
        }
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : $t("TaskCenter.load_failed"));
    } finally {
      isLoading = false;
      isRefreshing = false;
    }
  }

  function scheduleTaskListRefresh(delay = 750) {
    if (taskListRefreshTimer) return;
    taskListRefreshTimer = setTimeout(() => {
      taskListRefreshTimer = null;
      void fetchTasks(true);
    }, delay);
  }

  function scheduleSelectedTaskRefresh(taskId: string, delay = 750) {
    if (selectedTaskRefreshTimer) clearTimeout(selectedTaskRefreshTimer);
    selectedTaskRefreshTimer = setTimeout(() => {
      selectedTaskRefreshTimer = null;
      void fetchTaskDetail(taskId, true);
    }, delay);
  }

  function patchTaskList(list: TaskRecord[], payload: Record<string, unknown>) {
    let found = false;
    let updatedTask: TaskRecord | null = null;
    const updatedAt = typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString();
    const next = list.map((task) => {
      if (task.id !== payload.taskId) return task;
      found = true;
      updatedTask = {
        ...task,
        task_type: typeof payload.taskType === "string" ? payload.taskType : task.task_type,
        status: typeof payload.status === "string" ? payload.status : task.status,
        error: typeof payload.error === "string" || payload.error === null ? payload.error : task.error,
        updated_at: updatedAt,
      };
      return updatedTask;
    });
    return { found, updatedTask, next };
  }

  function applyTaskUpdate(payload: Record<string, unknown>) {
    if (payload.type !== "task_update" || payload.projectRef !== projectRef || typeof payload.taskId !== "string") {
      return;
    }

    const primary = patchTaskList(tasks, payload);
    const dlq = patchTaskList(dlqTasks, payload);
    tasks = primary.next;
    dlqTasks = dlq.next;

    const updatedTask = primary.updatedTask || dlq.updatedTask;
    const status = typeof payload.status === "string" ? payload.status : "";

    if (updatedTask && status === "dead_lettered" && !dlq.found) {
      dlqTasks = [updatedTask, ...dlqTasks].slice(0, 100);
    } else if (dlq.found && status && status !== "dead_lettered") {
      dlqTasks = dlqTasks.filter((task) => task.id !== payload.taskId);
    }

    if (selectedTask?.id === payload.taskId) {
      selectedTask = {
        ...selectedTask,
        ...(updatedTask || {}),
        status: status || selectedTask.status,
        error: typeof payload.error === "string" || payload.error === null ? payload.error : selectedTask.error,
      };
      scheduleSelectedTaskRefresh(selectedTask.id, 900);
    }

    if (!primary.found && !dlq.found) {
      scheduleTaskListRefresh(500);
    } else if (["succeeded", "failed", "dead_lettered", "cancelled"].includes(status)) {
      scheduleTaskListRefresh(1200);
    }
  }

  function scheduleReconnect() {
    if (!shouldReconnect || typeof window === "undefined") return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    liveStatus = reconnectAttempts === 0 ? "polling" : "reconnecting";
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      setupRealtime(true);
    }, delay);
  }

  function setupRealtime(isReconnect = false) {
    if (typeof window === "undefined") return;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }

    liveStatus = isReconnect ? "reconnecting" : "connecting";
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ project: projectRef ?? "" });
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/tasks?${params.toString()}`);

    ws.onopen = () => {
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      liveStatus = "connected";
      void fetchTasks(true);
    };

    ws.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data);
        applyTaskUpdate(payload);
      } catch {
      }
    };

    ws.onclose = () => {
      void fetchTasks(true);
      scheduleReconnect();
    };

    ws.onerror = () => {
      liveStatus = "polling";
      ws?.close();
    };
  }

  async function fetchTaskDetail(taskId: string, silent = false) {
    if (!silent) isLoadingDetail = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/tasks/${taskId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || $t("TaskCenter.load_detail_failed"));
      selectedTask = data;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : $t("TaskCenter.load_detail_failed"));
    } finally {
      isLoadingDetail = false;
    }
  }

  async function retryTask(taskId: string) {
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/tasks/${taskId}/retry`, {
        method: "POST"
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || $t("TaskCenter.retry_failed"));
      toast.success($t("TaskCenter.retry_success"));
      await fetchTasks(true);
      await fetchTaskDetail(taskId, true);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : $t("TaskCenter.retry_failed"));
    }
  }

  async function cancelTask(taskId: string) {
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/tasks/${taskId}/cancel`, {
        method: "POST"
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || $t("TaskCenter.cancel_failed"));
      toast.success($t("TaskCenter.cancel_success"));
      await fetchTasks(true);
      await fetchTaskDetail(taskId, true);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : $t("TaskCenter.cancel_failed"));
    }
  }

  async function saveSettings() {
    if (!draftSettings) return;

    try {
      isSavingSettings = true;
      const res = await apiClient(`/v1/projects/${projectRef}/tasks/settings/background`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftSettings)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || $t("TaskCenter.save_settings_failed"));
      backgroundSettings = data;
      draftSettings = { ...data };
      toast.success($t("TaskCenter.save_settings_success"));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : $t("TaskCenter.save_settings_failed"));
    } finally {
      isSavingSettings = false;
    }
  }

  async function copyText(text: string, successMessage?: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage || $t("Common.copied"));
    } catch {
      toast.error($t("Common.copy_failed"));
    }
  }

  function downloadAttemptLogs(task: TaskRecord | null) {
    if (!task?.attempts?.length) {
      toast.error($t("TaskCenter.no_downloadable_logs"));
      return;
    }

    const downloadableLogs = task.attempts
      .flatMap((attempt) => (attempt.logs || []).map((log) => ({
        task_id: task.id,
        attempt_no: attempt.attempt_no,
        ...log,
      })));

    const blob = new Blob([JSON.stringify(downloadableLogs, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${task.id}-attempt-logs.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function getFilteredLogs(attempt: AttemptRecord) {
    return (attempt.logs || []).filter((log) => {
      const streamMatch = logFilter === "all" || log.stream === logFilter;
      const searchMatch = !logSearch || log.message.toLowerCase().includes(logSearch.toLowerCase());
      return streamMatch && searchMatch;
    });
  }

  function updateLogContainer(el: HTMLDivElement | null) {
    activeLogContainer = el;
    if (el && autoScrollLogs) {
      queueMicrotask(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }

  $effect(() => {
    functionSlugFilter = routeFunctionSlug;
  });

  $effect(() => {
    if (autoScrollLogs && activeLogContainer) {
      queueMicrotask(() => {
        activeLogContainer!.scrollTop = activeLogContainer!.scrollHeight;
      });
    }
  });

  $effect(() => {
    if (!routeTaskId) {
      return;
    }

    const taskExists = [...tasks, ...dlqTasks].some((task) => task.id === routeTaskId);
    if (!taskExists) {
      return;
    }

    const currentSelectedTaskId = untrack(() => selectedTask?.id);
    if (currentSelectedTaskId === routeTaskId) {
      return;
    }

    void fetchTaskDetail(routeTaskId, true);
  });

  function getStatusIcon(status: string) {
    switch (status) {
      case "succeeded":
        return CheckCircle2;
      case "failed":
      case "dead_lettered":
        return AlertCircle;
      case "running":
      case "leased":
        return Loader2;
      case "cancelled":
        return XCircle;
      default:
        return Clock3;
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case "succeeded":
        return "text-emerald-600 bg-emerald-500/10 border-emerald-500/20";
      case "failed":
      case "dead_lettered":
        return "text-red-600 bg-red-500/10 border-red-500/20";
      case "running":
      case "leased":
        return "text-blue-600 bg-blue-500/10 border-blue-500/20";
      case "retry_scheduled":
        return "text-amber-700 bg-amber-500/10 border-amber-500/20";
      case "cancelled":
        return "text-slate-600 bg-slate-500/10 border-slate-500/20";
      default:
        return "text-zinc-600 bg-zinc-500/10 border-zinc-500/20";
    }
  }

  function taskStatusLabel(status: string): string {
    const statusKey = taskStatusKeys[status];
    return statusKey ? $t(`TaskCenter.status_${statusKey}`) : status;
  }

  const filteredTasks = $derived(
    activeTab === "dlq" ? dlqTasks : tasks
  );

  onMount(() => {
    fetchTasks();
    setupRealtime();
    pollTimer = setInterval(() => {
      if (liveStatus !== "connected") {
        fetchTasks(true);
      }
    }, 5000);

    return () => {
      shouldReconnect = false;
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (taskListRefreshTimer) clearTimeout(taskListRefreshTimer);
      if (selectedTaskRefreshTimer) clearTimeout(selectedTaskRefreshTimer);
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    };
  });
</script>

<div class="h-full flex flex-col gap-6 max-w-7xl mx-auto py-6 px-8">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
        <Activity class="w-6 h-6 text-brand" />
        {$t("TaskCenter.title")}
      </h1>
      <p class="text-sm text-muted-foreground mt-1">
        {$t("TaskCenter.subtitle")}
      </p>
    </div>

    <button
      onclick={() => fetchTasks(true)}
      disabled={isRefreshing || isLoading}
      class="flex items-center gap-2 px-4 py-2 border rounded-lg bg-card hover:bg-muted/50 transition-colors text-sm font-medium disabled:opacity-50"
    >
      <RefreshCw size={16} class={isRefreshing ? "animate-spin" : ""} />
      {$t("Common.refresh")}
    </button>
  </div>

  <div class="flex items-center gap-2 text-xs text-muted-foreground">
    <span class={`inline-block w-2 h-2 rounded-full ${liveStatus === "connected" ? "bg-emerald-500" : liveStatus === "connecting" || liveStatus === "reconnecting" ? "bg-amber-500" : liveStatus === "polling" ? "bg-sky-500" : "bg-red-500"}`}></span>
    {#if liveStatus === "connected"}
      {$t("TaskCenter.live_connected")}
    {:else if liveStatus === "connecting"}
      {$t("TaskCenter.live_connecting")}
    {:else if liveStatus === "reconnecting"}
      {$t("TaskCenter.live_reconnecting")}
    {:else if liveStatus === "polling"}
      {$t("TaskCenter.live_polling")}
    {:else}
      {$t("TaskCenter.live_disconnected")}
    {/if}
  </div>

  <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.8fr)] gap-6 min-h-0 flex-1">
    <div class="border rounded-xl bg-card shadow-sm overflow-hidden flex flex-col min-h-[700px]">
      <div class="border-b px-5 py-4 bg-muted/20 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <button
            class={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${activeTab === "all" ? "bg-brand text-white border-brand" : "bg-background hover:bg-muted/50"}`}
            onclick={() => activeTab = "all"}
          >
            {$t("TaskCenter.all_tasks")}
          </button>
          <button
            class={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${activeTab === "dlq" ? "bg-red-600 text-white border-red-600" : "bg-background hover:bg-muted/50"}`}
            onclick={() => activeTab = "dlq"}
          >
            {$t("TaskCenter.dead_letter_queue")}
          </button>
          <button
            class={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${activeTab === "settings" ? "bg-foreground text-background border-foreground" : "bg-background hover:bg-muted/50"}`}
            onclick={() => activeTab = "settings"}
          >
            {$t("TaskCenter.background_settings")}
          </button>
        </div>

        {#if activeTab !== "settings"}
          <div class="flex flex-1 flex-wrap items-center gap-2">
            <input
              bind:value={statusFilter}
              oninput={() => scheduleTaskListRefresh()}
              placeholder={$t("TaskCenter.status_filter_placeholder")}
              class="w-full sm:w-72 px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <input
              bind:value={functionSlugFilter}
              oninput={() => scheduleTaskListRefresh()}
              placeholder={$t("TaskCenter.function_filter_placeholder")}
              class="w-full sm:w-80 px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
        {/if}
      </div>

      {#if activeTab === "settings"}
        <div class="p-6 space-y-5 overflow-auto">
          {#if draftSettings}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="space-y-2">
                <span class="text-sm font-medium text-foreground">{$t("TaskCenter.concurrency")}</span>
                <input type="number" min="1" max="30" bind:value={draftSettings.concurrency} class="w-full px-3 py-2 text-sm rounded-lg border bg-background" />
              </label>
              <label class="space-y-2">
                <span class="text-sm font-medium text-foreground">{$t("TaskCenter.max_attempts")}</span>
                <input type="number" min="1" max="10" bind:value={draftSettings.max_attempts} class="w-full px-3 py-2 text-sm rounded-lg border bg-background" />
              </label>
              <label class="space-y-2">
                <span class="text-sm font-medium text-foreground">{$t("TaskCenter.default_timeout")}</span>
                <input type="number" min="1" max="900" bind:value={draftSettings.timeout_sec_default} class="w-full px-3 py-2 text-sm rounded-lg border bg-background" />
              </label>
              <label class="space-y-2">
                <span class="text-sm font-medium text-foreground">{$t("TaskCenter.max_timeout")}</span>
                <input type="number" min="1" max="1800" bind:value={draftSettings.timeout_sec_max} class="w-full px-3 py-2 text-sm rounded-lg border bg-background" />
              </label>
              <label class="space-y-2 md:col-span-2">
                <span class="text-sm font-medium text-foreground">{$t("TaskCenter.max_payload")}</span>
                <input type="number" min="1024" max="1048576" bind:value={draftSettings.max_payload_bytes} class="w-full px-3 py-2 text-sm rounded-lg border bg-background" />
              </label>
            </div>
          {/if}

          <div class="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-900/80">
            {$t("TaskCenter.settings_warning")}
          </div>

          <button
            onclick={saveSettings}
            disabled={isSavingSettings || !draftSettings}
            class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50"
          >
            <Save size={16} />
            {isSavingSettings ? $t("TaskCenter.saving") : $t("TaskCenter.save_settings")}
          </button>
        </div>
      {:else if isLoading && filteredTasks.length === 0}
        <div class="flex-1 flex items-center justify-center">
          <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        </div>
      {:else if filteredTasks.length === 0}
        <div class="flex-1 flex flex-col items-center justify-center p-16 text-center">
          <div class="w-14 h-14 rounded-full bg-muted/40 flex items-center justify-center mb-4 text-muted-foreground">
            <ShieldAlert size={28} />
          </div>
          <h3 class="text-lg font-medium text-foreground">
            {activeTab === "dlq" ? $t("TaskCenter.no_dlq_tasks") : functionSlugFilter ? $t("TaskCenter.no_function_tasks") : $t("TaskCenter.no_tasks")}
          </h3>
          <p class="text-sm text-muted-foreground mt-1 max-w-md">
            {activeTab === "dlq"
              ? $t("TaskCenter.no_dlq_tasks_desc")
              : functionSlugFilter
                ? $t("TaskCenter.no_function_tasks_desc", { values: { slug: functionSlugFilter } })
                : $t("TaskCenter.no_tasks_desc")}
          </p>
        </div>
      {:else}
        <div class="overflow-auto flex-1">
          <table class="w-full text-sm text-left">
            <thead class="bg-muted/30 text-xs uppercase text-muted-foreground border-b border-border/50 sticky top-0 z-10">
              <tr>
                <th class="px-5 py-3 font-semibold">{$t("TaskCenter.task")}</th>
                <th class="px-5 py-3 font-semibold">{$t("TaskCenter.status")}</th>
                <th class="px-5 py-3 font-semibold whitespace-nowrap">{$t("TaskCenter.attempts")}</th>
                <th class="px-5 py-3 font-semibold">{$t("TaskCenter.function")}</th>
                <th class="px-5 py-3 font-semibold">{$t("TaskCenter.updated_at")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/50">
              {#each filteredTasks as task (task.id)}
                {@const Icon = getStatusIcon(task.status)}
                <tr
                  class={`hover:bg-muted/20 transition-colors cursor-pointer ${selectedTask?.id === task.id ? "bg-brand/5" : ""}`}
                  onclick={() => fetchTaskDetail(task.id)}
                >
                  <td class="px-5 py-4 align-top">
                    <div class="font-mono text-[11px] text-muted-foreground break-all">{task.id}</div>
                    {#if task.error}
                      <div class="text-xs text-red-600 mt-1 line-clamp-2 max-w-sm">{task.error}</div>
                    {/if}
                  </td>
                  <td class="px-5 py-4 align-top">
                    <div class={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider border ${getStatusColor(task.status)}`}>
                      <Icon size={12} class={task.status === "running" || task.status === "leased" ? "animate-spin" : ""} />
                      <span title={task.status}>{taskStatusLabel(task.status)}</span>
                    </div>
                  </td>
                  <td class="px-5 py-4 align-top text-xs text-muted-foreground whitespace-nowrap min-w-16">
                    {task.attempt || 0} / {task.max_attempts || "-"}
                  </td>
                  <td class="px-5 py-4 align-top">
                    <div class="text-xs font-medium text-foreground">{task.function_slug || task.task_type}</div>
                    {#if task.function_version}
                      <div class="text-[11px] text-muted-foreground mt-1">v{task.function_version}</div>
                    {/if}
                  </td>
                  <td class="px-5 py-4 align-top text-xs font-mono text-muted-foreground whitespace-nowrap">
                    {dayjs(task.updated_at).format("YYYY-MM-DD HH:mm:ss")}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <div class="border rounded-xl bg-card shadow-sm overflow-hidden flex flex-col min-h-[700px]">
      <div class="border-b px-5 py-4 bg-muted/20 flex items-center justify-between">
        <div>
          <h2 class="text-base font-semibold text-foreground">{$t("TaskCenter.task_details")}</h2>
          <p class="text-xs text-muted-foreground mt-1">{$t("TaskCenter.task_details_desc")}</p>
        </div>
      </div>

      {#if isLoadingDetail}
        <div class="flex-1 flex items-center justify-center">
          <Loader2 size={28} class="animate-spin text-brand opacity-50" />
        </div>
      {:else if !selectedTask}
        <div class="flex-1 flex flex-col items-center justify-center text-center p-10">
          <div class="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center mb-4 text-muted-foreground">
            <ChevronDown size={22} />
          </div>
          <p class="text-sm text-muted-foreground">{$t("TaskCenter.select_task_hint")}</p>
        </div>
      {:else}
        <div class="flex-1 overflow-auto p-5 space-y-5">
          <div class="space-y-3">
            <div>
              <div class="text-[11px] uppercase tracking-wider text-muted-foreground">{$t("TaskCenter.task_id")}</div>
              <div class="font-mono text-xs break-all text-foreground mt-1">{selectedTask.id}</div>
            </div>
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div class="text-[11px] uppercase tracking-wider text-muted-foreground">{$t("TaskCenter.status")}</div>
                <div class="mt-1" title={selectedTask.status}>{taskStatusLabel(selectedTask.status)}</div>
              </div>
              <div>
                <div class="text-[11px] uppercase tracking-wider text-muted-foreground">{$t("TaskCenter.function")}</div>
                <div class="mt-1">{selectedTask.function_slug || selectedTask.task_type}</div>
              </div>
              <div>
                <div class="text-[11px] uppercase tracking-wider text-muted-foreground">{$t("TaskCenter.created_at")}</div>
                <div class="mt-1 text-xs font-mono">{dayjs(selectedTask.created_at).format("YYYY-MM-DD HH:mm:ss")}</div>
              </div>
              <div>
                <div class="text-[11px] uppercase tracking-wider text-muted-foreground">{$t("TaskCenter.updated_at")}</div>
                <div class="mt-1 text-xs font-mono">{dayjs(selectedTask.updated_at).format("YYYY-MM-DD HH:mm:ss")}</div>
              </div>
            </div>

            {#if selectedTask.error}
              <div class="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
                <div class="text-[11px] uppercase tracking-wider text-red-700 font-semibold">{$t("TaskCenter.error_details")}</div>
                <div class="mt-2 text-sm text-red-900/90 break-all">{selectedTask.error}</div>
              </div>
            {/if}
          </div>

          <div class="flex items-center gap-2">
            <button
              onclick={() => retryTask(selectedTask!.id)}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-background hover:bg-muted/50 text-sm font-medium"
            >
              <RotateCcw size={15} />
              {$t("TaskCenter.retry")}
            </button>
            <button
              onclick={() => cancelTask(selectedTask!.id)}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-background hover:bg-muted/50 text-sm font-medium"
            >
              <XCircle size={15} />
              {$t("TaskCenter.cancel_task")}
            </button>
            <button
              onclick={() => copyText(selectedTask?.error || JSON.stringify(selectedTask?.latest_logs || [], null, 2), $t("TaskCenter.copy_success"))}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-background hover:bg-muted/50 text-sm font-medium"
            >
              <Copy size={15} />
              {$t("TaskCenter.copy_error_logs")}
            </button>
            <button
              onclick={() => downloadAttemptLogs(selectedTask)}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-background hover:bg-muted/50 text-sm font-medium"
            >
              <Download size={15} />
              {$t("TaskCenter.download_logs")}
            </button>
            {#if selectedTask?.function_slug && projectRef}
              <a
                href={resolve('/project/[ref]/functions', { ref: projectRef })}
                class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-background hover:bg-muted/50 text-sm font-medium"
              >
                <ExternalLink size={15} />
                {$t("TaskCenter.open_functions")}
              </a>
            {/if}
          </div>

          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <Settings2 size={16} class="text-muted-foreground" />
              <h3 class="text-sm font-semibold text-foreground">{$t("TaskCenter.attempt_records")}</h3>
            </div>

            <div class="flex flex-wrap items-center gap-2 rounded-xl border bg-background px-3 py-2">
              <select bind:value={logFilter} class="px-2 py-1.5 text-xs rounded border bg-background">
                <option value="all">{$t("TaskCenter.all_logs")}</option>
                <option value="stdout">{$t("TaskCenter.stdout_only")}</option>
                <option value="stderr">{$t("TaskCenter.stderr_only")}</option>
              </select>
              <input
                bind:value={logSearch}
                placeholder={$t("TaskCenter.search_logs")}
                class="flex-1 min-w-[180px] px-3 py-1.5 text-xs rounded border bg-background"
              />
              <label class="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" bind:checked={autoScrollLogs} />
                {$t("TaskCenter.auto_scroll")}
              </label>
            </div>

            {#if selectedTask.attempts && selectedTask.attempts.length > 0}
              <div class="space-y-3">
                {#each selectedTask.attempts as attempt (attempt.attempt_no)}
                  <div class="rounded-xl border border-border/60 bg-background p-4 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-semibold text-foreground">{$t("TaskCenter.attempt_number", { values: { count: attempt.attempt_no } })}</span>
                        <span class={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${getStatusColor(attempt.status)}`}>
                          <span title={attempt.status}>{taskStatusLabel(attempt.status)}</span>
                        </span>
                      </div>
                      {#if attempt.duration_ms != null}
                        <span class="text-[11px] font-mono text-muted-foreground">{attempt.duration_ms} ms</span>
                      {/if}
                    </div>

                    <div class="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <div class="uppercase tracking-wider text-muted-foreground">{$t("TaskCenter.started_at")}</div>
                        <div class="mt-1 font-mono text-foreground">{dayjs(attempt.started_at).format("YYYY-MM-DD HH:mm:ss")}</div>
                      </div>
                      <div>
                        <div class="uppercase tracking-wider text-muted-foreground">{$t("TaskCenter.completed_at")}</div>
                        <div class="mt-1 font-mono text-foreground">
                          {attempt.completed_at ? dayjs(attempt.completed_at).format("YYYY-MM-DD HH:mm:ss") : "-"}
                        </div>
                      </div>
                    </div>

                    {#if attempt.response_status != null}
                      <div class="text-xs text-muted-foreground">
                        {$t("TaskCenter.http_status")}：<span class="font-mono text-foreground">{attempt.response_status}</span>
                      </div>
                    {/if}

                    {#if attempt.error}
                      <div class="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-900/90 break-all">
                        {attempt.error}
                      </div>
                    {/if}

                    <div class="rounded-lg border border-border/60 overflow-hidden">
                      <div class="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/30">
                        {$t("TaskCenter.execution_logs")}
                      </div>
                      {#if getFilteredLogs(attempt).length > 0}
                        <div
                          class="max-h-56 overflow-auto bg-zinc-950 text-zinc-100 text-[11px] font-mono divide-y divide-white/5"
                          bind:this={activeLogContainer}
                        >
                          {#each getFilteredLogs(attempt) as log (`${log.timestamp}-${log.stream}-${log.message}`)}
                            <div class="px-3 py-2">
                              <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-400">
                                <span>{log.stream}</span>
                                <span>{dayjs(log.timestamp).format("HH:mm:ss")}</span>
                              </div>
                              <div class={`mt-1 whitespace-pre-wrap break-words ${log.stream === "stderr" ? "text-red-300" : "text-zinc-100"}`}>
                                {log.message}
                              </div>
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <div class="px-3 py-4 text-xs text-muted-foreground bg-background">
                          {$t("TaskCenter.no_filtered_logs")}
                        </div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="rounded-xl border border-dashed p-6 text-sm text-muted-foreground text-center">
                {$t("TaskCenter.no_attempts")}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
