<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import dayjs from "dayjs";
  import { t } from "svelte-i18n";
  import { Loader2, Zap, Trash2, KeyRound, Clock, Plus, X, Upload, Code2, Copy, BookOpen, ArrowRight, Activity, RadioTower, ShieldCheck, RotateCcw, GitBranch, Bug, BarChart3 } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createMutation } from "@tanstack/svelte-query";
  import { useList, type BaseRecord } from "@svadmin/core";
  import {
    buildCurlExample,
    buildFunctionTaskConsolePath,
    buildFunctionTasksPath,
    buildInvokeAsyncExample,
    buildJsInvokeExample,
    buildTsInvokeExample,
    getStatusBadgeClass,
    type FunctionTaskRecord,
  } from "$lib/function-snippets";
  import { getTaskLatestLogPreview, hasTaskLogPreview } from "$lib/function-task-details";
  import { requestImmutableFunctionVersion } from "$lib/function-version-details";
  import {
    filterFunctionRuntimeLogs,
    getFunctionRuntimeErrorLogs,
    getFunctionRuntimeLogClass,
    getFunctionRuntimeSeveritySummary,
    getRecentFunctionRuntimeLogs,
    hasFunctionRuntimeWarnings,
    type FunctionRuntimeSeverityFilter,
    type FunctionRuntimeLogRecord,
  } from "$lib/function-runtime-logs";
  import { summarizeFunctionTasks } from "$lib/function-task-summary";
  import {
    isObservedFunctionActivationId,
    parseAbsentFunctionIdentity,
    parseFunctionActivationReceipt,
    parseFunctionConfigReceipt,
    parseFunctionCreateReceipt,
    parseFunctionDeleteReceipt,
  } from "$lib/edge-function-mutation-receipts";

  interface EdgeFunction extends BaseRecord {
    id: string;
    slug: string;
    name: string;
    status: string;
    version: number;
    activation_id: string;
    verify_jwt: boolean;
    created_at: string;
    updated_at: string;
  }

  interface EdgeFunctionVersion {
    version: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    bundle_path: string | null;
    source_path: string | null;
    source_dir_path: string | null;
    has_bundle: boolean;
    has_source: boolean;
    has_source_dir: boolean;
  }

  interface EdgeFunctionVersionDetail extends EdgeFunctionVersion {
    bundle_code: string | null;
    source_code: string | null;
  }

  interface VerifyJwtRequest {
    slug: string;
    verifyJwt: boolean;
  }

  const projectRef = $derived(page.params.ref);

  function requiredProjectRef(): string {
    if (typeof projectRef !== "string" || projectRef.length === 0) {
      throw new Error("当前项目标识无效，请刷新后重试");
    }
    return projectRef;
  }

  const query = useList<EdgeFunction>({ get resource() { return `v1/projects/${projectRef}/functions`; } });
  const fetchedFunctions = $derived(Array.isArray(query.data?.data) ? query.data.data : ((query.data?.data as unknown as Record<string, unknown>)?.functions as EdgeFunction[] || []));
  let functions = $state<EdgeFunction[]>([]);
  let showCreate = $state(false);
  let selectedFunction = $state<EdgeFunction | null>(null);
  let drawerOpen = $state(false);
  let jwtUpdatingSlug = $state<string | null>(null);
  let functionTasks = $state<FunctionTaskRecord[]>([]);
  let taskDetails = $state<Record<string, {
    id: string;
    status: string;
    error?: string | null;
    latest_logs?: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }>;
    attempts?: Array<{
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
    }>;
  }>>({});
  let tasksLoading = $state(false);
  let tasksError = $state<string | null>(null);
  let taskDetailLoadingId = $state<string | null>(null);
  let taskDetailError = $state<string | null>(null);
  let functionRuntimeLogs = $state<FunctionRuntimeLogRecord[]>([]);
  let functionLogsLoading = $state(false);
  let functionLogsError = $state<string | null>(null);
  let functionVersions = $state<EdgeFunctionVersion[]>([]);
  let versionsLoading = $state(false);
  let versionsError = $state<string | null>(null);
  let selectedVersion = $state<EdgeFunctionVersionDetail | null>(null);
  let selectedVersionKey = $state<string | null>(null);
  let versionDetailLoading = $state<string | null>(null);
  let versionDetailError = $state<string | null>(null);
  let versionSwitching = $state<string | null>(null);
  let runtimeSeverityFilter = $state<FunctionRuntimeSeverityFilter>("all");
  let runtimeLogSearch = $state("");
  let runtimeLogLimit = $state(20);
  let expandedTaskId = $state<string | null>(null);
  let newSlug = $state("");
  let newCode = $state(`export default async function handler(req: Request) {
  const { name } = await req.json();
  const data = {
    message: \`Hello \${name}!\`,
  };

  return new Response(
    JSON.stringify(data),
    { headers: { "Content-Type": "application/json" } },
  );
}`);
  let deploying = $state(false);
  let deployMsg = $state<string | null>(null);

  $effect(() => {
    functions = fetchedFunctions;
  });

  const invokeAsyncHelperCode = `import type { SupabaseClient } from "@supabase/supabase-js";

type InvokeAsyncOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  retries?: number;
  timeoutSec?: number;
  idempotencyKey?: string;
  method?: string;
};

export async function invokeAsync(
  supabase: SupabaseClient,
  functionName: string,
  options: InvokeAsyncOptions = {},
) {
  const {
    body,
    headers = {},
    retries,
    timeoutSec,
    idempotencyKey,
    method,
  } = options;

  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
    method,
    headers,
  });

  if (error) throw error;

  return data as {
    task_id: string;
    status: "enqueued";
  };
}`;

  const invokeAsyncExampleCode = `const task = await invokeAsync(supabase, "mockup-generator", {
  body: {
    product_id: "prod_123",
    image_url: "https://example.com/source.png",
  },
  retries: 3,
  timeoutSec: 300,
  idempotencyKey: "mockup-prod_123-v1",
});

console.log(task);
// { task_id: "tsk_...", status: "enqueued" }`;

  const currentDrawerSlug = $derived(selectedFunction?.slug || "");
  const selectedVersionSnapshot = $derived(selectedVersion);
  const functionTaskSummary = $derived(summarizeFunctionTasks(functionTasks));
  const filteredRuntimeLogs = $derived(
    filterFunctionRuntimeLogs(functionRuntimeLogs, {
      severity: runtimeSeverityFilter,
      search: runtimeLogSearch,
    }),
  );
  const functionRuntimeErrorLogs = $derived(
    getFunctionRuntimeErrorLogs(filteredRuntimeLogs),
  );
  const functionRuntimeRecentLogs = $derived(
    getRecentFunctionRuntimeLogs(filteredRuntimeLogs, runtimeLogLimit),
  );
  const functionHasRuntimeWarnings = $derived(
    hasFunctionRuntimeWarnings(functionRuntimeLogs),
  );
  const runtimeSeveritySummary = $derived(
    getFunctionRuntimeSeveritySummary(functionRuntimeLogs),
  );

  function functionStatusLabel(status: string) {
    return status === "ACTIVE" ? $t("Functions.status_active") : status;
  }

  const taskPollingHelperCode = `async function getTask(
  managementApiUrl: string,
  projectRef: string,
  taskId: string,
  accessToken: string,
) {
  const response = await fetch(
    \`\${managementApiUrl}/v1/projects/\${projectRef}/tasks/\${taskId}\`,
    {
      headers: {
        authorization: \`Bearer \${accessToken}\`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(\`Failed to fetch task: \${response.status}\`);
  }

  return response.json();
}

const terminalStatuses = new Set([
  "succeeded",
  "failed",
  "dead_lettered",
  "cancelled",
]);

export async function waitForTask(
  managementApiUrl: string,
  projectRef: string,
  taskId: string,
  accessToken: string,
  intervalMs = 2000,
) {
  while (true) {
    const task = await getTask(
      managementApiUrl,
      projectRef,
      taskId,
      accessToken,
    );

    if (terminalStatuses.has(task.status)) {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}`;

  const cancellationAwareFunctionCode = `export default async function handler(req: Request) {
  const payload = await req.json();
  req.signal.throwIfAborted?.();

  const taskId = process.env.SUPACLOUD_BACKGROUND_TASK_ID;
  const attempt = process.env.SUPACLOUD_BACKGROUND_ATTEMPT || "1";

  const abortController = new AbortController();
  const onAbort = () => abortController.abort("supacloud task cancelled");
  req.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (let step = 0; step < 5; step += 1) {
      req.signal.throwIfAborted?.();
      console.log(\`[task=\${taskId}] attempt=\${attempt} step=\${step}\`);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        abortController.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Task cancelled", "AbortError"));
        }, { once: true });
      });
    }

    return Response.json({ ok: true, payload });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return Response.json({ ok: false, cancelled: true }, { status: 499 });
    }

    throw error;
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}`;

  async function copySnippet(content: string, label: string) {
    try {
      await navigator.clipboard.writeText(content);
      toast.success(`${label} 已复制`);
    } catch {
      toast.error(`无法复制 ${label}`);
    }
  }

  async function loadFunctionTasks(slug: string, version?: string | null) {
    tasksLoading = true;
    tasksError = null;
    try {
      const res = await apiClient(
        buildFunctionTasksPath(String(projectRef), slug, 8, version),
      );
      const payload = await res.json().catch(() => []);
      if (!res.ok) {
        throw new Error(payload?.message || "获取函数任务失败");
      }
      functionTasks = Array.isArray(payload) ? payload : [];
    } catch (error) {
      functionTasks = [];
      tasksError = error instanceof Error ? error.message : "获取函数任务失败";
    } finally {
      tasksLoading = false;
    }
  }

  async function loadFunctionRuntimeLogs(slug: string, limit = runtimeLogLimit, version?: string | null) {
    functionLogsLoading = true;
    functionLogsError = null;
    try {
      const query = new URLSearchParams({
        limit: String(limit),
      });
      if (version) {
        query.set("version", version);
      }
      const res = await apiClient(
        `/v1/projects/${projectRef}/functions/${encodeURIComponent(slug)}/logs?${query.toString()}`,
      );
      const payload = await res.json().catch(() => ({ logs: [] }));
      if (!res.ok) {
        throw new Error(payload?.message || "获取函数日志失败");
      }

      functionRuntimeLogs = Array.isArray(payload?.logs) ? payload.logs : [];
    } catch (error) {
      functionRuntimeLogs = [];
      functionLogsError = error instanceof Error ? error.message : "获取函数日志失败";
    } finally {
      functionLogsLoading = false;
    }
  }

  async function loadFunctionVersions(slug: string) {
    versionsLoading = true;
    versionsError = null;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/functions/${encodeURIComponent(slug)}/versions`);
      const payload = await res.json().catch(() => []);
      if (!res.ok) {
        throw new Error(payload?.message || "获取函数版本失败");
      }
      functionVersions = Array.isArray(payload) ? payload : [];
    } catch (error) {
      functionVersions = [];
      versionsError = error instanceof Error ? error.message : "获取函数版本失败";
    } finally {
      versionsLoading = false;
    }
  }

  async function loadVersionDetail(slug: string, version: string) {
    versionDetailLoading = version;
    versionDetailError = null;
    try {
      const res = await requestImmutableFunctionVersion(apiClient, {
        projectRef,
        slug,
        version,
      });
      if (res === null) {
        selectedVersion = null;
        selectedVersionKey = null;
        versionDetailError = "兼容版本 v0 仅作为并发控制标记，不提供不可变版本详情";
        return;
      }
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.message || "获取函数版本详情失败");
      }
      selectedVersion = payload;
      selectedVersionKey = version;
      await Promise.all([
        loadFunctionTasks(slug, version),
        loadFunctionRuntimeLogs(slug, runtimeLogLimit, version),
      ]);
    } catch (error) {
      versionDetailError = error instanceof Error ? error.message : "获取函数版本详情失败";
    } finally {
      versionDetailLoading = null;
    }
  }

  function activeVersionForSlug(slug: string): string {
    const activeVersion = functions.find((fn) => fn.slug === slug)?.version;
    if (typeof activeVersion !== "number" || !Number.isSafeInteger(activeVersion) || activeVersion < 0) {
      throw new Error("当前函数激活版本无效，请刷新后重试");
    }
    return String(activeVersion);
  }

  function activationIdForSlug(slug: string): string {
    const activationId = functions.find((fn) => fn.slug === slug)?.activation_id;
    if (!isObservedFunctionActivationId(activationId)) {
      throw new Error("当前函数激活标识无效，请刷新后重试");
    }
    return activationId;
  }

  async function activateFunctionVersion(slug: string, version: string) {
    versionSwitching = version;
    try {
      const functionProjectRef = requiredProjectRef();
      const expectedActiveVersion = activeVersionForSlug(slug);
      const expectedActivationId = activationIdForSlug(slug);
      const res = await apiClient(`/v1/projects/${functionProjectRef}/functions/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_active_version: expectedActiveVersion,
          expected_activation_id: expectedActivationId,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.message || "切换函数版本失败");
      }
      const receipt = parseFunctionActivationReceipt(payload, {
        projectRef: functionProjectRef,
        slug,
        expectedActivationId,
        previousActiveVersion: expectedActiveVersion,
        targetVersion: version,
      });

      toast.success(`${slug} 已切换到 v${version}`);
      if (selectedFunction?.slug === slug) {
        selectedFunction = {
          ...selectedFunction,
          version: Number(receipt.activeVersion),
          activation_id: receipt.activationId,
        };
      }
      await Promise.all([
        loadFunctionVersions(slug),
        query.refetch(),
        loadVersionDetail(slug, version),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换函数版本失败");
    } finally {
      versionSwitching = null;
    }
  }

  async function loadTaskDetail(taskId: string) {
    taskDetailLoadingId = taskId;
    taskDetailError = null;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/tasks/${encodeURIComponent(taskId)}`);
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.message || "获取任务详情失败");
      }

      taskDetails = {
        ...taskDetails,
        [taskId]: payload,
      };
    } catch (error) {
      taskDetailError = error instanceof Error ? error.message : "获取任务详情失败";
    } finally {
      taskDetailLoadingId = null;
    }
  }

  async function openFunctionDrawer(fn: EdgeFunction) {
    selectedFunction = fn;
    drawerOpen = true;
    taskDetailError = null;
    runtimeSeverityFilter = "all";
    runtimeLogSearch = "";
    runtimeLogLimit = 20;
    selectedVersion = null;
    selectedVersionKey = null;
    versionDetailError = null;
    await Promise.all([
      loadFunctionTasks(fn.slug, String(fn.version)),
      loadFunctionRuntimeLogs(fn.slug, 20, String(fn.version)),
      loadFunctionVersions(fn.slug),
    ]);
    await loadVersionDetail(fn.slug, String(fn.version));
  }

  function closeFunctionDrawer() {
    drawerOpen = false;
    selectedFunction = null;
    functionTasks = [];
    taskDetails = {};
    tasksError = null;
    taskDetailError = null;
    functionRuntimeLogs = [];
    functionLogsError = null;
    functionVersions = [];
    versionsError = null;
    selectedVersion = null;
    selectedVersionKey = null;
    versionDetailError = null;
    versionDetailLoading = null;
    versionSwitching = null;
    runtimeSeverityFilter = "all";
    runtimeLogSearch = "";
    runtimeLogLimit = 20;
    expandedTaskId = null;
  }

  async function toggleExpandedTask(taskId: string) {
    expandedTaskId = expandedTaskId === taskId ? null : taskId;
    if (expandedTaskId === taskId && !taskDetails[taskId]) {
      await loadTaskDetail(taskId);
    }
  }

  const deployMutation = createMutation(() => ({
    mutationFn: async () => {
      const functionProjectRef = requiredProjectRef();
      const slug = newSlug.trim();
      const resourcePath = `/v1/projects/${functionProjectRef}/functions/${encodeURIComponent(slug)}`;
      const identityResponse = await apiClient(`${resourcePath}/config`);
      const identityPayload = await identityResponse.json().catch(() => null);
      if (!identityResponse.ok) {
        throw new Error(identityPayload?.message || "读取函数激活标识失败");
      }
      const identity = parseAbsentFunctionIdentity(identityPayload, {
        projectRef: functionProjectRef,
        slug,
      });
      const res = await apiClient(resourcePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: newCode,
          expected_active_version: "absent",
          expected_activation_id: identity.activationId,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error || payload?.message || res.statusText);
      }
      const receipt = parseFunctionCreateReceipt(payload, {
        projectRef: functionProjectRef,
        slug,
        expectedActivationId: identity.activationId,
      });
      return { slug, receipt };
    },
    onSuccess: ({ slug }) => {
      deployMsg = `✅ 函数 "${slug}" 部署成功`;
      showCreate = false;
      newSlug = "";
      query.refetch();
      setTimeout(() => deployMsg = null, 4000);
    },
    onError: (err: unknown) => {
      deployMsg = `❌ 部署失败: ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => deployMsg = null, 4000);
    }
  }));

  function deployFunction() {
    if (!newSlug.trim()) {
      deployMsg = "❌ 请输入函数名称（slug）";
      setTimeout(() => deployMsg = null, 3000);
      return;
    }
    deployMsg = null;
    deployMutation.mutate();
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async (slug: string) => {
      const functionProjectRef = requiredProjectRef();
      const previousActiveVersion = activeVersionForSlug(slug);
      const expectedActivationId = activationIdForSlug(slug);
      const res = await apiClient(`/v1/projects/${functionProjectRef}/functions/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_activation_id: expectedActivationId }),
      });
      if (!res.ok) throw new Error("Delete failed");
      parseFunctionDeleteReceipt(await res.json(), {
        projectRef: functionProjectRef,
        slug,
        expectedActivationId,
        previousActiveVersion,
      });
      return { slug };
    },
    onSuccess: (data) => {
      deployMsg = `函数 "${data.slug}" 已删除`;
      setTimeout(() => deployMsg = null, 3000);
      query.refetch();
    },
    onError: () => {
      toast.error("无法删除函数");
    }
  }));

  function deleteFunction(slug: string) {
    if (!confirm(`确定删除 Edge Function "${slug}"？此操作不可恢复。`)) return;
    deleteMutation.mutate(slug);
  }

  const verifyJwtMutation = createMutation(() => ({
    mutationFn: async ({ slug, verifyJwt }: VerifyJwtRequest) => {
      const functionProjectRef = requiredProjectRef();
      const expectedActivationId = activationIdForSlug(slug);
      const res = await apiClient(`/v1/projects/${functionProjectRef}/functions/${encodeURIComponent(slug)}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verify_jwt: verifyJwt,
          expected_activation_id: expectedActivationId,
        }),
      });
      if (!res.ok) throw new Error("Function configuration update failed");
      const receipt = parseFunctionConfigReceipt(await res.json(), {
        projectRef: functionProjectRef,
        slug,
        expectedActivationId,
        verifyJwt,
      });
      return { slug, verifyJwt: receipt.verifyJwt, activationId: receipt.activationId };
    },
    onMutate: ({ slug }) => {
      jwtUpdatingSlug = slug;
    },
    onSuccess: ({ slug, verifyJwt, activationId }) => {
      functions = functions.map((fn) => (
        fn.slug === slug ? { ...fn, verify_jwt: verifyJwt, activation_id: activationId } : fn
      ));
      if (selectedFunction?.slug === slug) {
        selectedFunction = { ...selectedFunction, verify_jwt: verifyJwt, activation_id: activationId };
      }
      toast.success(`${slug}: ${$t(verifyJwt ? "Functions.jwt_enabled" : "Functions.jwt_disabled")}`);
      void query.refetch();
    },
    onError: (_error, { slug }) => {
      toast.error($t("Functions.jwt_update_failed", { values: { slug } }));
    },
    onSettled: () => {
      jwtUpdatingSlug = null;
    },
  }));

  function toggleVerifyJwt(fn: EdgeFunction) {
    verifyJwtMutation.mutate({ slug: fn.slug, verifyJwt: !fn.verify_jwt });
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">{$t("Navigation.edge_functions")}</h1>
    <div class="flex items-center gap-2">
      <a href={`/project/${projectRef}/tasks`}
        class="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border hover:bg-muted/50 transition-colors">
        <Activity size={14} /> {$t("Functions.background_tasks")}
      </a>
      <a href={`/project/${projectRef}/functions/secrets`}
        class="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border hover:bg-muted/50 transition-colors">
        <KeyRound size={14} /> {$t("Functions.secrets")}
      </a>
      <button onclick={() => showCreate = !showCreate}
        class="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-brand text-white hover:bg-brand/90 transition-colors">
        {#if showCreate}<X size={14} /> {$t("Functions.cancel")}{:else}<Plus size={14} /> {$t("Functions.create_new")}{/if}
      </button>
    </div>
  </div>

  <details class="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/5 via-background to-blue-500/5">
    <summary class="flex cursor-pointer list-none items-start justify-between gap-4 rounded-2xl p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
      <div class="space-y-2">
        <div class="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-brand/10 text-brand text-[11px] font-bold uppercase tracking-[0.18em]">
          <Activity size={12} />
          {$t("Functions.background_title")}
        </div>
        <div>
          <h2 class="text-lg font-semibold text-foreground">{$t("Functions.background_heading")} <code>supabase.functions.invoke()</code></h2>
          <p class="text-sm text-muted-foreground mt-1 max-w-3xl">
            {$t("Functions.background_description_before")} <code>supabase-js</code>，{$t("Functions.background_description_between")} <code>background_routes</code> {$t("Functions.background_description_after")} <code>invokeAsync()</code> {$t("Functions.background_description_end")}
          </p>
        </div>
      </div>
      <span class="shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold text-muted-foreground">{$t("Functions.view_examples")}</span>
    </summary>

    <div class="grid gap-4 border-t border-brand/15 p-5 pt-4 xl:grid-cols-[1.15fr_0.85fr]">
      <div class="space-y-4">
        <div class="rounded-xl border border-border/60 bg-background/80 backdrop-blur-sm p-4 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-semibold">{$t("Functions.copy_helper")} <code>invokeAsync()</code></div>
              <p class="text-xs text-muted-foreground mt-1">{$t("Functions.copy_helper_desc_before")} <code>supabase.functions.invoke()</code>，{$t("Functions.copy_helper_desc_after")} <code>background_routes</code>。</p>
            </div>
            <button
              onclick={() => copySnippet(invokeAsyncHelperCode, "invokeAsync helper")}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
            >
              <Copy size={14} />
              {$t("Functions.copy")}
            </button>
          </div>
          <pre class="rounded-xl bg-slate-950 text-slate-100 p-4 text-[11px] leading-5 overflow-auto border border-slate-900/80"><code>{invokeAsyncHelperCode}</code></pre>
        </div>

        <div class="flex items-center justify-between gap-3">
          <div class="rounded-xl border border-border/60 bg-background/80 p-4 space-y-3 w-full">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-semibold">{$t("Functions.copy_task_helper")}</div>
                <p class="text-xs text-muted-foreground mt-1">{$t("Functions.copy_task_helper_desc")}</p>
              </div>
              <button
                onclick={() => copySnippet(taskPollingHelperCode, "任务轮询 helper")}
                class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
              >
                <Copy size={14} />
                {$t("Functions.copy")}
              </button>
            </div>
            <pre class="rounded-xl bg-slate-950 text-slate-100 p-4 text-[11px] leading-5 overflow-auto border border-slate-900/80"><code>{taskPollingHelperCode}</code></pre>
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="rounded-xl border border-border/60 bg-background/80 p-4 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-semibold">{$t("Functions.copy_example")}</div>
              <p class="text-xs text-muted-foreground mt-1">{$t("Functions.copy_example_desc")}</p>
            </div>
            <button
              onclick={() => copySnippet(invokeAsyncExampleCode, "异步调用示例")}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
            >
              <Copy size={14} />
              {$t("Functions.copy")}
            </button>
          </div>
          <pre class="rounded-xl bg-slate-950 text-slate-100 p-4 text-[11px] leading-5 overflow-auto border border-slate-900/80"><code>{invokeAsyncExampleCode}</code></pre>
        </div>

        <div class="rounded-xl border border-border/60 bg-background/80 p-4 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-semibold">{$t("Functions.copy_cancellable_example")}</div>
              <p class="text-xs text-muted-foreground mt-1">{$t("Functions.copy_cancellable_example_desc")}</p>
            </div>
            <button
              onclick={() => copySnippet(cancellationAwareFunctionCode, "可取消函数示例")}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
            >
              <Copy size={14} />
              {$t("Functions.copy")}
            </button>
          </div>
          <pre class="rounded-xl bg-slate-950 text-slate-100 p-4 text-[11px] leading-5 overflow-auto border border-slate-900/80"><code>{cancellationAwareFunctionCode}</code></pre>
        </div>

        <div class="rounded-xl border border-border/60 bg-background/80 p-4 space-y-3">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <BookOpen size={15} class="text-brand" />
            {$t("Functions.integration_guidance")}
          </div>
          <div class="space-y-2 text-xs text-muted-foreground leading-5">
            <p>1. {$t("Functions.guidance_sdk_before")} <code>supabase-js</code>，{$t("Functions.guidance_sdk_after")}</p>
            <p>2. {$t("Functions.guidance_routes_before")} <code>background_routes</code>，{$t("Functions.guidance_routes_after")}</p>
            <p>3. {$t("Functions.guidance_signal")}</p>
          </div>
          <div class="grid gap-2 pt-1 sm:grid-cols-2">
            <a
              href={`/project/${projectRef}/tasks`}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-brand text-white text-xs font-semibold hover:bg-brand/90 transition-colors"
            >
              {$t("Functions.view_task_status")}
              <ArrowRight size={14} />
            </a>
            <a
              href={`/project/${projectRef}/functions/secrets`}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
            >
              <ShieldCheck size={14} />
              {$t("Functions.manage_secrets")}
            </a>
          </div>
          <div class="rounded-lg bg-muted/40 border border-border/50 px-3 py-2 text-[11px] text-muted-foreground leading-5">
            {$t("Functions.guidance_footer")}
          </div>
        </div>
      </div>
    </div>
  </details>

  {#if deployMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {deployMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : deployMsg.startsWith('❌') ? 'bg-red-500/5 border-red-500/20 text-red-700' : 'bg-blue-500/5 border-blue-500/20 text-blue-700'}">
      {deployMsg}
    </div>
  {/if}

  <!-- Create/Deploy Panel -->
  {#if showCreate}
    <div class="rounded-xl border border-brand/20 bg-brand/5 p-4 space-y-3">
      <div class="flex items-center gap-2">
        <Code2 size={16} class="text-brand" />
        <span class="font-semibold text-sm">创建 Edge Function</span>
      </div>
      <div>
        <span class="text-[10px] font-semibold text-muted-foreground uppercase">函数名称 (slug)</span>
        <input type="text" bind:value={newSlug} placeholder="hello-world"
          class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
      <div>
        <span class="text-[10px] font-semibold text-muted-foreground uppercase">函数代码 (TypeScript / Bun)</span>
        <textarea bind:value={newCode} rows={12}
          class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand resize-y leading-5"
          spellcheck="false"></textarea>
      </div>
      <div class="flex items-center justify-between">
        <p class="text-[10px] text-muted-foreground">函数将被部署到 <code class="text-[9px] bg-muted px-1 rounded">/functions/v1/{newSlug || "slug"}</code></p>
        <button onclick={deployFunction} disabled={deployMutation.isPending}
          class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
          {#if deployMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Upload size={14} />{/if}
          部署
        </button>
      </div>
    </div>
  {/if}

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if query.isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在查询 Edge Functions...</p>
      </div>
    {:else if functions.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <div class="w-16 h-16 rounded-full bg-brand/10 flex items-center justify-center">
          <Zap size={28} class="text-brand opacity-50" />
        </div>
        <p class="text-foreground font-medium">{$t("Functions.no_functions")}</p>
        <p class="text-xs max-w-md text-center">{$t("Functions.description")}</p>
        <button onclick={() => showCreate = true}
          class="mt-3 flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
          <Plus size={14} /> 创建第一个函数
        </button>
      </div>
    {:else}
      <div class="overflow-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-muted/30 border-b">
            <tr>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">{$t("Functions.function_name")}</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">{$t("Functions.status")}</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">{$t("Functions.jwt_verification")}</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">{$t("Functions.endpoint")}</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">{$t("Functions.created_at")}</th>
              <th class="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/30">
            {#each functions as fn}
              <tr class="hover:bg-muted/5 transition-colors group">
                <td class="px-5 py-3">
                  <button
                    onclick={() => openFunctionDrawer(fn)}
                    class="flex items-center gap-2 text-left hover:text-brand transition-colors"
                  >
                    <Zap size={14} class="text-brand" />
                    <span class="font-mono font-semibold text-xs">{fn.slug}</span>
                  </button>
                </td>
                <td class="px-5 py-3">
                  <span title={fn.status} class="px-2 py-0.5 rounded-full text-[9px] font-bold {fn.status === 'ACTIVE' ? 'text-green-600 bg-green-500/10' : 'text-amber-600 bg-amber-500/10'}">{functionStatusLabel(fn.status)}</span>
                </td>
                <td class="px-5 py-3">
                  <button
                    type="button"
                    onclick={() => toggleVerifyJwt(fn)}
                    disabled={verifyJwtMutation.isPending}
                    aria-busy={jwtUpdatingSlug === fn.slug}
                    aria-pressed={fn.verify_jwt}
                    aria-label={$t(fn.verify_jwt ? "Functions.jwt_disable_action" : "Functions.jwt_enable_action")}
                    class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-wait disabled:opacity-70 {fn.verify_jwt ? 'bg-brand' : 'bg-muted-foreground/30'}"
                    title={$t(fn.verify_jwt ? "Functions.jwt_disable_action" : "Functions.jwt_enable_action")}
                  >
                    {#if jwtUpdatingSlug === fn.slug}
                      <Loader2 size={12} class="absolute left-3 animate-spin text-white" />
                    {:else}
                      <span class="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform shadow-sm {fn.verify_jwt ? 'translate-x-[18px]' : 'translate-x-[3px]'}"></span>
                    {/if}
                  </button>
                </td>
                <td class="px-5 py-3">
                  <code class="text-[10px] text-muted-foreground">/functions/v1/{fn.slug}</code>
                </td>
                <td class="px-5 py-3 text-muted-foreground text-xs font-mono tabular-nums">
                  <div class="flex items-center gap-1"><Clock size={12} />{new Date(fn.created_at).toLocaleDateString()}</div>
                </td>
                <td class="px-5 py-3 text-right">
                  <button onclick={() => deleteFunction(fn.slug)} disabled={deleteMutation.isPending}
                    class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded text-muted-foreground transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                    title="删除">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

{#if drawerOpen && selectedFunction}
  <button
    type="button"
    class="fixed inset-0 z-40 bg-slate-950/45 backdrop-blur-[1px]"
    onclick={closeFunctionDrawer}
    aria-label="关闭函数详情遮罩"
  ></button>
  <aside class="fixed right-0 top-0 z-50 h-full w-full max-w-3xl border-l border-border/60 bg-background shadow-2xl flex flex-col">
    <div class="px-6 py-5 border-b border-border/60 flex items-start justify-between gap-4">
      <div class="space-y-2">
        <div class="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-brand/10 text-brand text-[11px] font-bold uppercase tracking-[0.18em]">
          <Zap size={12} />
          Function Detail
        </div>
        <div>
          <h2 class="text-xl font-semibold font-mono">{selectedFunction.slug}</h2>
          <p class="text-sm text-muted-foreground mt-1">
            在当前函数上下文里直接查看可复制调用方式、最近后台任务和失败记录，不用再跳去任务页找上下文。
          </p>
        </div>
      </div>
      <button
        onclick={closeFunctionDrawer}
        class="inline-flex items-center justify-center w-9 h-9 rounded-lg border hover:bg-muted/40 transition-colors"
        aria-label="关闭函数详情"
      >
        <X size={16} />
      </button>
    </div>

    <div class="flex-1 overflow-auto px-6 py-5 space-y-5">
      <div class="grid gap-4 md:grid-cols-3">
        <div class="rounded-xl border border-border/60 bg-muted/20 p-4">
          <div class="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{$t("Functions.status")}</div>
          <div title={selectedFunction.status} class="mt-2 text-sm font-semibold">{functionStatusLabel(selectedFunction.status)}</div>
        </div>
        <div class="rounded-xl border border-border/60 bg-muted/20 p-4">
          <div class="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{$t("Functions.version")}</div>
          <div class="mt-2 text-sm font-semibold">v{selectedFunction.version}</div>
        </div>
        <div class="rounded-xl border border-border/60 bg-muted/20 p-4">
          <div class="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{$t("Functions.jwt_verification")}</div>
          <div class="mt-2 text-sm font-semibold">{selectedFunction.verify_jwt ? $t("Functions.enabled") : $t("Functions.disabled")}</div>
        </div>
        <div class="rounded-xl border border-border/60 bg-muted/20 p-4">
          <div class="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{$t("Functions.endpoint")}</div>
          <div class="mt-2 text-xs font-mono text-foreground break-all">/functions/v1/{selectedFunction.slug}</div>
        </div>
        <div class="rounded-xl border border-border/60 bg-muted/20 p-4">
          <div class="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{$t("Functions.last_deploy")}</div>
          <div class="mt-2 text-sm font-semibold">{dayjs(selectedFunction.updated_at).format("YYYY-MM-DD HH:mm:ss")}</div>
        </div>
        <div class="rounded-xl border border-border/60 bg-muted/20 p-4">
          <div class="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{$t("Functions.created_at")}</div>
          <div class="mt-2 text-sm font-semibold">{dayjs(selectedFunction.created_at).format("YYYY-MM-DD HH:mm:ss")}</div>
        </div>
      </div>

      <div class="rounded-xl border border-border/60 bg-background p-4 space-y-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm font-semibold flex items-center gap-2">
              <GitBranch size={15} class="text-brand" />
              函数版本管理
            </div>
            <p class="text-xs text-muted-foreground mt-1">查看历史版本、检查源码/编译产物，并将当前激活版本切换到任意历史版本。</p>
          </div>
          <div class="text-[11px] text-muted-foreground">
            {$t("Functions.active_version", { values: { version: selectedFunction.version } })}
          </div>
        </div>

        {#if versionsLoading}
          <div class="rounded-xl border border-border/50 bg-muted/20 py-10 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 size={24} class="animate-spin" />
            <p class="text-xs font-mono uppercase tracking-[0.16em]">正在加载函数版本...</p>
          </div>
        {:else if versionsError}
          <div class="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-700">
            {versionsError}
          </div>
        {:else}
          <div class="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
            <div class="space-y-3">
              {#if functionVersions.length === 0}
                <div class="rounded-xl border border-border/50 bg-muted/20 py-8 text-center text-sm text-muted-foreground">
                  暂时没有可用的版本快照。
                </div>
              {:else}
                {#each functionVersions as versionRecord}
                  <div class={`rounded-xl border p-4 space-y-3 transition-colors ${
                    versionRecord.is_active
                      ? "border-brand/30 bg-brand/5"
                      : "border-border/50 bg-muted/20"
                  }`}>
                    <div class="flex items-start justify-between gap-3">
                      <div class="space-y-1">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="font-mono font-semibold text-sm">v{versionRecord.version}</span>
                          {#if versionRecord.is_active}
                            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-brand/10 text-brand">{$t("Functions.status_active")}</span>
                          {/if}
                        </div>
                        <div class="text-[11px] text-muted-foreground">
                          {dayjs(versionRecord.updated_at).format("YYYY-MM-DD HH:mm:ss")}
                        </div>
                      </div>
                      <div class="flex items-center gap-2">
                        <button
                          onclick={() => loadVersionDetail(currentDrawerSlug, versionRecord.version)}
                          disabled={versionRecord.version === "0"}
                          title={versionRecord.version === "0" ? "兼容版本 v0 不提供不可变版本详情" : "查看版本详情"}
                          class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors disabled:opacity-50"
                        >
                          <Bug size={13} />
                          查看详情
                        </button>
                        <button
                          onclick={() => activateFunctionVersion(currentDrawerSlug, versionRecord.version)}
                          disabled={versionRecord.version === "0" || versionRecord.is_active || versionSwitching === versionRecord.version}
                          title={versionRecord.version === "0" ? "兼容版本 v0 仅供服务内部恢复" : "切换到此版本"}
                          class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors disabled:opacity-50"
                        >
                          {#if versionSwitching === versionRecord.version}
                            <Loader2 size={13} class="animate-spin" />
                          {:else}
                            <RotateCcw size={13} />
                          {/if}
                          切换到此版本
                        </button>
                      </div>
                    </div>

                    <div class="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                      <span class="px-2 py-1 rounded-md border bg-background/70">bundle: {versionRecord.has_bundle ? "yes" : "no"}</span>
                      <span class="px-2 py-1 rounded-md border bg-background/70">source: {versionRecord.has_source ? "yes" : "no"}</span>
                      <span class="px-2 py-1 rounded-md border bg-background/70">source dir: {versionRecord.has_source_dir ? "yes" : "no"}</span>
                    </div>
                  </div>
                {/each}
              {/if}
            </div>

            <div class="space-y-4">
              <div class="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="text-sm font-semibold">版本源码 / 编译产物</div>
                    <p class="text-xs text-muted-foreground mt-1">用于快速判断某个版本到底部署了什么、以及 bundle 结果是否符合预期。</p>
                  </div>
                  {#if selectedVersion}
                    <div class="text-[11px] text-muted-foreground">当前查看 v{selectedVersion.version}</div>
                  {/if}
                </div>

                {#if versionDetailLoading}
                  <div class="rounded-xl border border-border/50 bg-background/80 py-10 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                    <Loader2 size={24} class="animate-spin" />
                    <p class="text-xs font-mono uppercase tracking-[0.16em]">正在加载版本详情...</p>
                  </div>
                {:else if versionDetailError}
                  <div class="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-700">
                    {versionDetailError}
                  </div>
                {:else if selectedVersionSnapshot}
                  <div class="space-y-4">
                    <div class="grid gap-3 sm:grid-cols-3">
                      <div class="rounded-lg border border-border/50 bg-background/70 p-3">
                        <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Version</div>
                        <div class="mt-2 text-lg font-semibold">v{selectedVersionSnapshot.version}</div>
                      </div>
                      <div class="rounded-lg border border-border/50 bg-background/70 p-3">
                        <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Bundle</div>
                        <div class="mt-2 text-lg font-semibold">{selectedVersionSnapshot.has_bundle ? "Ready" : "Missing"}</div>
                      </div>
                      <div class="rounded-lg border border-border/50 bg-background/70 p-3">
                        <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Source</div>
                        <div class="mt-2 text-lg font-semibold">{selectedVersionSnapshot.has_source ? "Ready" : "Missing"}</div>
                      </div>
                    </div>

                    <div class="space-y-3">
                      <div>
                        <div class="flex items-center justify-between gap-3">
                          <div class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Source Code</div>
                          {#if selectedVersionSnapshot.source_code}
                            <button
                              onclick={() => copySnippet(selectedVersionSnapshot.source_code || "", `v${selectedVersionSnapshot.version} source code`)}
                              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
                            >
                              <Copy size={13} />
                              复制源码
                            </button>
                          {/if}
                        </div>
                        {#if selectedVersionSnapshot.source_code}
                          <pre class="mt-2 rounded-xl bg-slate-950 text-slate-100 p-4 text-[11px] leading-5 overflow-auto border border-slate-900/80 max-h-72"><code>{selectedVersionSnapshot.source_code}</code></pre>
                        {:else}
                          <div class="mt-2 rounded-lg border border-border/50 bg-background/70 px-3 py-2 text-xs text-muted-foreground">这个版本没有保留源码快照。</div>
                        {/if}
                      </div>

                      <div>
                        <div class="flex items-center justify-between gap-3">
                          <div class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Bundled Output</div>
                          {#if selectedVersionSnapshot.bundle_code}
                            <button
                              onclick={() => copySnippet(selectedVersionSnapshot.bundle_code || "", `v${selectedVersionSnapshot.version} bundle output`)}
                              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
                            >
                              <Copy size={13} />
                              复制 bundle
                            </button>
                          {/if}
                        </div>
                        {#if selectedVersionSnapshot.bundle_code}
                          <pre class="mt-2 rounded-xl bg-slate-950 text-slate-100 p-4 text-[11px] leading-5 overflow-auto border border-slate-900/80 max-h-72"><code>{selectedVersionSnapshot.bundle_code}</code></pre>
                        {:else}
                          <div class="mt-2 rounded-lg border border-border/50 bg-background/70 px-3 py-2 text-xs text-muted-foreground">这个版本没有可用的编译产物。</div>
                        {/if}
                      </div>
                    </div>
                  </div>
                {:else}
                  <div class="rounded-xl border border-border/50 bg-background/80 py-10 text-center text-sm text-muted-foreground">
                    先从左侧选择一个版本查看详情。
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </div>

      <div class="grid gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-border/60 bg-background p-4 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-semibold">针对当前函数生成好的 `invokeAsync()` 示例</div>
              <p class="text-xs text-muted-foreground mt-1">直接把 slug 预填成 `"{currentDrawerSlug}"`。</p>
            </div>
            <button
              onclick={() => copySnippet(buildInvokeAsyncExample(currentDrawerSlug), `${currentDrawerSlug} invokeAsync 示例`)}
              class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
            >
              <Copy size={14} />
              复制
            </button>
          </div>
          <pre class="rounded-xl bg-slate-950 text-slate-100 p-4 text-[11px] leading-5 overflow-auto border border-slate-900/80"><code>{buildInvokeAsyncExample(currentDrawerSlug)}</code></pre>
        </div>

        <div class="rounded-xl border border-border/60 bg-background p-4 space-y-3">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <BookOpen size={15} class="text-brand" />
            复制 cURL / JS / TS 三种调用方式
          </div>

          <div class="space-y-3">
            <div class="rounded-lg border border-border/50 p-3 space-y-2">
              <div class="flex items-center justify-between gap-3">
                <div class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">cURL</div>
                <button
                  onclick={() => copySnippet(buildCurlExample(currentDrawerSlug), `${currentDrawerSlug} cURL 示例`)}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-semibold hover:bg-muted/40 transition-colors"
                >
                  <Copy size={12} />
                  复制
                </button>
              </div>
              <pre class="rounded-lg bg-slate-950 text-slate-100 p-3 text-[10px] leading-5 overflow-auto border border-slate-900/80"><code>{buildCurlExample(currentDrawerSlug)}</code></pre>
            </div>

            <div class="rounded-lg border border-border/50 p-3 space-y-2">
              <div class="flex items-center justify-between gap-3">
                <div class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">JavaScript</div>
                <button
                  onclick={() => copySnippet(buildJsInvokeExample(currentDrawerSlug), `${currentDrawerSlug} JS 示例`)}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-semibold hover:bg-muted/40 transition-colors"
                >
                  <Copy size={12} />
                  复制
                </button>
              </div>
              <pre class="rounded-lg bg-slate-950 text-slate-100 p-3 text-[10px] leading-5 overflow-auto border border-slate-900/80"><code>{buildJsInvokeExample(currentDrawerSlug)}</code></pre>
            </div>

            <div class="rounded-lg border border-border/50 p-3 space-y-2">
              <div class="flex items-center justify-between gap-3">
                <div class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">TypeScript</div>
                <button
                  onclick={() => copySnippet(buildTsInvokeExample(currentDrawerSlug), `${currentDrawerSlug} TS 示例`)}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-semibold hover:bg-muted/40 transition-colors"
                >
                  <Copy size={12} />
                  复制
                </button>
              </div>
              <pre class="rounded-lg bg-slate-950 text-slate-100 p-3 text-[10px] leading-5 overflow-auto border border-slate-900/80"><code>{buildTsInvokeExample(currentDrawerSlug)}</code></pre>
            </div>
          </div>
        </div>
      </div>

      <div class="rounded-xl border border-border/60 bg-background p-4 space-y-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm font-semibold">版本关联任务和失败记录</div>
            <p class="text-xs text-muted-foreground mt-1">
              {#if selectedVersionKey}
                只看当前函数 `{currentDrawerSlug}` 的 v{selectedVersionKey} 任务记录，方便把失败、重试和日志片段绑定到具体版本。
              {:else}
                只看当前函数 `{currentDrawerSlug}` 的最新任务，帮助租户在函数上下文内快速排障。
              {/if}
            </p>
          </div>
          <a
            href={buildFunctionTaskConsolePath(String(projectRef), currentDrawerSlug)}
            class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
          >
            打开完整任务面板
            <ArrowRight size={14} />
          </a>
        </div>

        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div class="rounded-lg border border-border/50 bg-muted/20 p-3">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Running</div>
            <div class="mt-2 text-lg font-semibold text-blue-700">{functionTaskSummary.running}</div>
          </div>
          <div class="rounded-lg border border-border/50 bg-muted/20 p-3">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Retry</div>
            <div class="mt-2 text-lg font-semibold text-amber-700">{functionTaskSummary.retryScheduled}</div>
          </div>
          <div class="rounded-lg border border-border/50 bg-muted/20 p-3">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">DLQ</div>
            <div class="mt-2 text-lg font-semibold text-red-700">{functionTaskSummary.deadLettered}</div>
          </div>
          <div class="rounded-lg border border-border/50 bg-muted/20 p-3">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Failed</div>
            <div class="mt-2 text-lg font-semibold text-rose-700">{functionTaskSummary.failed}</div>
          </div>
          <div class="rounded-lg border border-border/50 bg-muted/20 p-3">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Cancelled</div>
            <div class="mt-2 text-lg font-semibold text-slate-700">{functionTaskSummary.cancelled}</div>
          </div>
        </div>

        {#if tasksLoading}
          <div class="rounded-xl border border-border/50 bg-muted/20 py-10 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 size={24} class="animate-spin" />
            <p class="text-xs font-mono uppercase tracking-[0.16em]">
              {selectedVersionKey ? `正在加载 v${selectedVersionKey} 相关任务...` : "正在加载函数相关任务..."}
            </p>
          </div>
        {:else if tasksError}
          <div class="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-700">
            {tasksError}
          </div>
        {:else if functionTasks.length === 0}
          <div class="rounded-xl border border-border/50 bg-muted/20 py-10 text-center text-sm text-muted-foreground">
            {selectedVersionKey ? `当前函数的 v${selectedVersionKey} 还没有后台任务记录。` : "当前函数还没有后台任务记录。"}
          </div>
        {:else}
          {#if functionTaskSummary.recentFailures.length > 0}
            <div class="rounded-xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
              <div class="text-sm font-semibold text-red-700">最近失败摘要</div>
              <div class="space-y-2">
                {#each functionTaskSummary.recentFailures.slice(0, 3) as failure}
                  <div class="rounded-lg border border-red-500/15 bg-background/80 px-3 py-2">
                    <div class="flex items-center justify-between gap-3">
                      <div class="font-mono text-[11px] text-muted-foreground break-all">{failure.id}</div>
                      <span class={`inline-flex items-center px-2 py-1 rounded-md border text-[10px] font-bold uppercase tracking-[0.12em] ${getStatusBadgeClass(failure.status)}`}>
                        {failure.status}
                      </span>
                    </div>
                    {#if failure.error}
                      <div class="mt-2 text-xs text-red-700 leading-5">{failure.error}</div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <div class="space-y-3">
            {#each functionTasks as task}
              <div class="rounded-xl border border-border/50 bg-muted/20 p-4 space-y-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="space-y-1">
                    <div class="font-mono text-xs text-muted-foreground break-all">{task.id}</div>
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class={`inline-flex items-center px-2.5 py-1 rounded-md border text-[11px] font-bold uppercase tracking-[0.12em] ${getStatusBadgeClass(task.status)}`}>
                        {task.status}
                      </span>
                      {#if task.function_version}
                        <span class="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                          <GitBranch size={11} />
                          v{task.function_version}
                        </span>
                      {/if}
                      <span class="text-[11px] text-muted-foreground">
                        attempt {task.attempt || 0} / {task.max_attempts || "-"}
                      </span>
                    </div>
                  </div>
                  <div class="text-[11px] text-muted-foreground text-right">
                    <div>{new Date(task.updated_at).toLocaleString()}</div>
                    <div class="mt-1">created {new Date(task.created_at).toLocaleDateString()}</div>
                  </div>
                </div>

                {#if task.error}
                  <div class="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700 leading-5">
                    {task.error}
                  </div>
                {/if}

                <div class="flex items-center gap-2">
                  <button
                    onclick={() => toggleExpandedTask(task.id)}
                    class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
                  >
                    {expandedTaskId === task.id ? "收起日志" : "展开日志"}
                  </button>
                  <a
                    href={buildFunctionTaskConsolePath(String(projectRef), currentDrawerSlug, task.id)}
                    class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
                  >
                    在任务页查看详情
                    <ArrowRight size={13} />
                  </a>
                </div>

                {#if expandedTaskId === task.id}
                  <div class="rounded-lg border border-border/50 bg-background/80 p-3 space-y-3">
                    <div class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recent Logs</div>
                    {#if taskDetailLoadingId === task.id}
                      <div class="rounded-lg border border-border/50 bg-muted/20 py-6 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <Loader2 size={18} class="animate-spin" />
                        <div class="text-xs font-mono uppercase tracking-[0.14em]">正在加载 task detail...</div>
                      </div>
                    {:else if taskDetailError}
                      <div class="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700 leading-5">
                        {taskDetailError}
                      </div>
                    {:else if taskDetails[task.id]?.attempts && taskDetails[task.id]!.attempts!.length > 0}
                      <div class="space-y-3">
                        {#each taskDetails[task.id]!.attempts!.slice(0, 2) as attempt}
                          <div class="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
                            <div class="flex items-center justify-between gap-3">
                              <div class="flex items-center gap-2">
                                <span class="text-xs font-semibold text-foreground">Attempt #{attempt.attempt_no}</span>
                                <span class={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${getStatusBadgeClass(attempt.status)}`}>
                                  {attempt.status}
                                </span>
                              </div>
                              <div class="text-[11px] font-mono text-muted-foreground">
                                {#if attempt.duration_ms != null}{attempt.duration_ms} ms{:else}-{/if}
                              </div>
                            </div>

                            {#if attempt.error}
                              <div class="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700 leading-5 break-words">
                                {attempt.error}
                              </div>
                            {/if}

                            {#if attempt.logs && attempt.logs.length > 0}
                              <div class="space-y-2">
                                {#each attempt.logs.slice(0, 4) as log}
                                  <div class={`rounded-md border px-3 py-2 text-xs leading-5 ${
                                    log.stream === "stderr"
                                      ? "border-red-500/20 bg-red-500/5 text-red-700"
                                      : "border-blue-500/20 bg-blue-500/5 text-blue-700"
                                  }`}>
                                    <div class="flex items-center justify-between gap-3 text-[11px] font-mono text-muted-foreground">
                                      <span>{log.stream}</span>
                                      <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                                    </div>
                                    <div class="mt-1 break-words">{log.message}</div>
                                  </div>
                                {/each}
                              </div>
                            {:else}
                              <div class="text-xs text-muted-foreground">这个 attempt 暂时没有采集到日志。</div>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {:else if hasTaskLogPreview(task)}
                      <div class="space-y-2">
                        {#each getTaskLatestLogPreview(task, 5) as log}
                          <div class={`rounded-md border px-3 py-2 text-xs leading-5 ${
                            log.stream === "stderr"
                              ? "border-red-500/20 bg-red-500/5 text-red-700"
                              : "border-blue-500/20 bg-blue-500/5 text-blue-700"
                          }`}>
                            <div class="flex items-center justify-between gap-3 text-[11px] font-mono text-muted-foreground">
                              <span>{log.stream}</span>
                              <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                            </div>
                            <div class="mt-1 break-words">{log.message}</div>
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <div class="text-xs text-muted-foreground">当前任务还没有最近日志摘要。</div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="rounded-xl border border-border/60 bg-background p-4 space-y-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm font-semibold flex items-center gap-2">
              <BarChart3 size={15} class="text-brand" />
              调试 / 日志 / 指标
            </div>
            <p class="text-xs text-muted-foreground mt-1">把函数本身运行日志和后台任务执行状态放到一个区块里，更容易判断是某个版本部署问题、还是任务执行问题。</p>
          </div>
          <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <RadioTower size={13} />
            最近 20 条
          </div>
        </div>

        <div class="grid gap-3 sm:grid-cols-3">
          <div class="rounded-lg border border-border/50 bg-muted/20 p-3">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Logs</div>
            <div class="mt-2 text-lg font-semibold text-blue-700">{functionRuntimeLogs.length}</div>
          </div>
          <div class="rounded-lg border border-border/50 bg-muted/20 p-3">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Errors</div>
            <div class="mt-2 text-lg font-semibold text-red-700">{runtimeSeveritySummary.errors}</div>
          </div>
          <div class="rounded-lg border border-border/50 bg-muted/20 p-3">
            <div class="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Warnings</div>
            <div class="mt-2 text-lg font-semibold text-amber-700">{runtimeSeveritySummary.warnings || (functionHasRuntimeWarnings ? "Yes" : "0")}</div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 rounded-xl border bg-background px-3 py-2">
          <select bind:value={runtimeSeverityFilter} class="px-2 py-1.5 text-xs rounded border bg-background">
            <option value="all">全部级别</option>
            <option value="error">仅 error</option>
            <option value="warning">仅 warning</option>
            <option value="info">仅 info</option>
          </select>
          <input
            bind:value={runtimeLogSearch}
            placeholder="搜索函数原始日志"
            class="flex-1 min-w-[180px] px-3 py-1.5 text-xs rounded border bg-background"
          />
          <button
            onclick={() => copySnippet(JSON.stringify(functionRuntimeLogs, null, 2), `${currentDrawerSlug} 原始函数日志`)}
            class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
          >
            <Copy size={13} />
            复制日志
          </button>
          <button
            onclick={() =>
              selectedFunction &&
              loadFunctionRuntimeLogs(
                selectedFunction.slug,
                runtimeLogLimit + 20,
                selectedVersionKey,
              )}
            class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-muted/40 transition-colors"
          >
            加载更多
          </button>
        </div>

        {#if functionLogsLoading}
          <div class="rounded-xl border border-border/50 bg-muted/20 py-10 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 size={24} class="animate-spin" />
            <p class="text-xs font-mono uppercase tracking-[0.16em]">正在加载函数原始日志...</p>
          </div>
        {:else if functionLogsError}
          <div class="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-700">
            {functionLogsError}
          </div>
        {:else if filteredRuntimeLogs.length === 0}
          <div class="rounded-xl border border-border/50 bg-muted/20 py-10 text-center text-sm text-muted-foreground">
            {selectedVersionKey ? `v${selectedVersionKey} 当前过滤条件下没有函数运行日志。` : "当前过滤条件下没有函数运行日志。"}
          </div>
        {:else}
          {#if functionRuntimeErrorLogs.length > 0}
            <div class="rounded-xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
              <div class="text-sm font-semibold text-red-700">最近原始错误</div>
              <div class="space-y-2">
                {#each functionRuntimeErrorLogs as log}
                  <div class="rounded-lg border border-red-500/15 bg-background/80 px-3 py-2">
                    <div class="flex items-center justify-between gap-3 text-[11px] font-mono text-muted-foreground">
                      <span class="flex items-center gap-2 flex-wrap">
                        <span>{log.severity}</span>
                        {#if typeof log.metadata?.function_version === "string" && log.metadata.function_version}
                          <span class="inline-flex items-center gap-1 rounded-md border border-red-500/20 bg-background px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-red-700">
                            <GitBranch size={10} />
                            v{log.metadata.function_version}
                          </span>
                        {/if}
                      </span>
                      <span>{new Date(log.timestamp).toLocaleString()}</span>
                    </div>
                    <div class="mt-2 text-xs text-red-700 leading-5 break-words">{log.message}</div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <div class="space-y-2">
            {#each functionRuntimeRecentLogs as log}
              <div class={`rounded-lg border px-3 py-2 text-xs leading-5 ${getFunctionRuntimeLogClass(log)}`}>
                <div class="flex items-center justify-between gap-3 text-[11px] font-mono text-muted-foreground">
                  <span class="flex items-center gap-2 flex-wrap">
                    <span>{log.severity} · {log.event_type}</span>
                    {#if typeof log.metadata?.function_version === "string" && log.metadata.function_version}
                      <span class="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                        <GitBranch size={10} />
                        v{log.metadata.function_version}
                      </span>
                    {/if}
                  </span>
                  <span>{new Date(log.timestamp).toLocaleString()}</span>
                </div>
                <div class="mt-1 break-words">{log.message}</div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </aside>
{/if}
