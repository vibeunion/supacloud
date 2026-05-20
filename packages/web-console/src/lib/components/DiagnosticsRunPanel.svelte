<script lang="ts">
  import { apiClient } from "$lib/api";
  import { onMount } from "svelte";
  import {
    AlertTriangle,
    CheckCircle2,
    Database,
    FileCheck2,
    Fingerprint,
    Loader2,
    RefreshCw,
    ShieldAlert,
    ShieldCheck,
  } from "lucide-svelte";

  type Scope = "platform" | "project";

  interface DiagnosticCheck {
    id: string;
    name: string;
    description: string;
    category: string;
    severity: "critical" | "warning" | "info";
    repairable: boolean;
  }

  interface DiagnosticRun {
    id: string;
    scope: Scope;
    projectRef: string | null;
    status: "running" | "completed" | "failed";
    startedAt: string;
    completedAt: string | null;
    summary: Record<string, number> | null;
  }

  interface DiagnosticResult {
    id: string;
    checkId: string;
    status: "pass" | "drift" | "missing" | "tampered" | "unreachable" | "degraded" | "error";
    message: string;
    detail: string | null;
    metadata: Record<string, unknown> | null;
  }

  let { scope, projectRef = null }: { scope: Scope; projectRef?: string | null } = $props();

  let checks = $state.raw<DiagnosticCheck[]>([]);
  let runs = $state.raw<DiagnosticRun[]>([]);
  let selectedRun = $state.raw<DiagnosticRun | null>(null);
  let results = $state.raw<DiagnosticResult[]>([]);
  let isLoading = $state(false);
  let isRunning = $state(false);
  let error = $state<string | null>(null);

  const basePath = $derived(scope === "project" ? `/v1/projects/${projectRef}/diagnostics` : "/v1/diagnostics");
  const title = $derived(scope === "project" ? "项目自检" : "平台自检中心");
  const subtitle = $derived(scope === "project" ? "数据库结构、权限、运行时与可信基线检查" : "全局服务、端口、管理库、配置基线与项目运行态检查");

  async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await apiClient(`${basePath}${path}`, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || data.error || `Request failed: ${res.status}`);
    }
    return data as T;
  }

  async function refreshRuns() {
    runs = await apiJson<DiagnosticRun[]>("/runs");
    if (runs.length > 0) {
      await selectRun(runs[0]);
    } else {
      selectedRun = null;
      results = [];
    }
  }

  async function loadChecks() {
    checks = await apiJson<DiagnosticCheck[]>("/checks");
  }

  async function selectRun(run: DiagnosticRun) {
    selectedRun = run;
    const data = await apiJson<{ run: DiagnosticRun; results: DiagnosticResult[] }>(`/runs/${run.id}/results`);
    selectedRun = data.run;
    results = data.results;
  }

  async function runDiagnostics() {
    isRunning = true;
    error = null;
    try {
      const run = await apiJson<DiagnosticRun>("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await refreshRuns();
      const fresh = runs.find((item) => item.id === run.id) ?? run;
      await selectRun(fresh);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      isRunning = false;
    }
  }

  async function loadAll() {
    isLoading = true;
    error = null;
    try {
      await Promise.all([loadChecks(), refreshRuns()]);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      isLoading = false;
    }
  }

  function statusClass(status: DiagnosticResult["status"]) {
    if (status === "pass") return "border-emerald-500/20 bg-emerald-500/5 text-emerald-700";
    if (status === "tampered" || status === "missing" || status === "unreachable" || status === "error") {
      return "border-red-500/20 bg-red-500/5 text-red-700";
    }
    return "border-amber-500/20 bg-amber-500/5 text-amber-700";
  }

  function statusLabel(status: DiagnosticResult["status"]) {
    const labels: Record<DiagnosticResult["status"], string> = {
      pass: "通过",
      drift: "漂移",
      missing: "缺失",
      tampered: "篡改",
      unreachable: "不可达",
      degraded: "降级",
      error: "错误",
    };
    return labels[status];
  }

  function severityClass(severity: DiagnosticCheck["severity"]) {
    if (severity === "critical") return "bg-red-500/10 text-red-700 border-red-500/20";
    if (severity === "warning") return "bg-amber-500/10 text-amber-700 border-amber-500/20";
    return "bg-blue-500/10 text-blue-700 border-blue-500/20";
  }

  function summaryCount(status: string) {
    return selectedRun?.summary?.[status] ?? 0;
  }

  function formatTime(value: string | null) {
    if (!value) return "-";
    return new Date(value).toLocaleString();
  }

  onMount(() => {
    void loadAll();
  });
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
    <div>
      <h1 class="text-2xl font-bold">{title}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={loadAll}
        disabled={isLoading || isRunning}
        class="flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
      >
        {#if isLoading}<Loader2 size={14} class="animate-spin" />{:else}<RefreshCw size={14} />{/if}
        刷新
      </button>
      <button
        type="button"
        onclick={runDiagnostics}
        disabled={isLoading || isRunning}
        class="flex items-center gap-2 rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
      >
        {#if isRunning}<Loader2 size={14} class="animate-spin" />{:else}<ShieldCheck size={14} />{/if}
        运行只读自检
      </button>
    </div>
  </div>

  {#if error}
    <div class="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700">{error}</div>
  {/if}

  <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">Checks</div>
      <div class="mt-1 text-2xl font-bold">{checks.length}</div>
    </div>
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">Pass</div>
      <div class="mt-1 text-2xl font-bold text-emerald-600">{summaryCount("pass")}</div>
    </div>
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">Tampered</div>
      <div class="mt-1 text-2xl font-bold text-red-600">{summaryCount("tampered")}</div>
    </div>
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">Degraded</div>
      <div class="mt-1 text-2xl font-bold text-amber-600">{summaryCount("degraded") + summaryCount("drift")}</div>
    </div>
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">Last Run</div>
      <div class="mt-1 truncate text-xs font-semibold">{selectedRun ? formatTime(selectedRun.startedAt) : "-"}</div>
    </div>
  </div>

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
    <section class="rounded-md border bg-card">
      <div class="border-b px-4 py-3">
        <h2 class="text-sm font-semibold">最近运行</h2>
      </div>
      <div class="max-h-[560px] overflow-y-auto p-2">
        {#if runs.length === 0}
          <div class="px-3 py-10 text-center text-xs text-muted-foreground">暂无运行记录</div>
        {:else}
          {#each runs as run (run.id)}
            <button
              type="button"
              onclick={() => selectRun(run)}
              class="mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors {selectedRun?.id === run.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}"
            >
              <span class="min-w-0">
                <span class="block truncate font-mono">{run.id}</span>
                <span class="mt-0.5 block truncate">{formatTime(run.startedAt)}</span>
              </span>
              <span class="rounded border px-1.5 py-0.5 text-[10px] uppercase">{run.status}</span>
            </button>
          {/each}
        {/if}
      </div>
    </section>

    <section class="rounded-md border bg-card">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <h2 class="text-sm font-semibold">检查结果</h2>
        {#if selectedRun}
          <span class="text-xs text-muted-foreground">{selectedRun.id}</span>
        {/if}
      </div>
      <div class="divide-y">
        {#if isLoading}
          <div class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 size={18} class="animate-spin" />
            加载中
          </div>
        {:else if results.length === 0}
          <div class="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            <FileCheck2 size={28} class="opacity-60" />
            <span class="text-sm">暂无检查结果</span>
          </div>
        {:else}
          {#each results as result (result.id)}
            <div class="p-4">
              <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div class="flex min-w-0 items-start gap-3">
                  <div class="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground">
                    {#if result.status === "pass"}
                      <CheckCircle2 size={16} />
                    {:else if result.status === "tampered" || result.status === "missing" || result.status === "error"}
                      <ShieldAlert size={16} />
                    {:else}
                      <AlertTriangle size={16} />
                    {/if}
                  </div>
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-mono text-xs font-semibold">{result.checkId}</span>
                      <span class="rounded border px-1.5 py-0.5 text-[10px] font-bold {statusClass(result.status)}">{statusLabel(result.status)}</span>
                    </div>
                    <p class="mt-1 text-sm">{result.message}</p>
                    {#if result.detail}
                      <p class="mt-1 break-all font-mono text-[11px] text-muted-foreground">{result.detail}</p>
                    {/if}
                  </div>
                </div>
                {#if result.metadata?.hash}
                  <div class="flex shrink-0 items-center gap-1 rounded-md border bg-muted/30 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    <Fingerprint size={12} />
                    {String(result.metadata.hash).slice(0, 12)}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </section>
  </div>

  <section class="rounded-md border bg-card">
    <div class="border-b px-4 py-3">
      <h2 class="text-sm font-semibold">已注册检查项</h2>
    </div>
    <div class="grid grid-cols-1 gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
      {#each checks as check (check.id)}
        <div class="rounded-md border bg-background p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <Database size={13} class="text-muted-foreground" />
                <span class="truncate font-mono text-xs font-semibold">{check.id}</span>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">{check.description}</p>
            </div>
            <span class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold {severityClass(check.severity)}">{check.severity}</span>
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>
