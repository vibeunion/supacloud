<script lang="ts">
  import { apiClient } from "$lib/api";
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
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
  const title = $derived(scope === "project" ? $t("Diagnostics.project_title") : $t("Diagnostics.platform_title"));
  const subtitle = $derived(scope === "project" ? $t("Diagnostics.project_subtitle") : $t("Diagnostics.platform_subtitle"));

  async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await apiClient(`${basePath}${path}`, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || data.error || $t("Diagnostics.request_failed", { values: { status: res.status } }));
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
      pass: "Diagnostics.status_pass",
      drift: "Diagnostics.status_drift",
      missing: "Diagnostics.status_missing",
      tampered: "Diagnostics.status_tampered",
      unreachable: "Diagnostics.status_unreachable",
      degraded: "Diagnostics.status_degraded",
      error: "Diagnostics.status_error",
    };
    return $t(labels[status]);
  }

  function runStatusLabel(status: DiagnosticRun["status"]): string {
    const labels: Record<DiagnosticRun["status"], string> = {
      running: "Diagnostics.run_status_running",
      completed: "Diagnostics.run_status_completed",
      failed: "Diagnostics.run_status_failed",
    };
    return $t(labels[status]);
  }

  function checkDescription(check: DiagnosticCheck): string {
    const key = CHECK_DESCRIPTION_KEYS[check.id];
    return key ? $t(key) : check.description;
  }

  function checkLabel(checkId: string): string {
    const descriptionKey = CHECK_DESCRIPTION_KEYS[checkId];
    return descriptionKey ? $t(descriptionKey) : checkId;
  }

  const CHECK_DESCRIPTION_KEYS: Record<string, string> = {
    "project-required-schemas": "Diagnostics.check_project_required_schemas",
    "project-rls-status": "Diagnostics.check_project_rls_status",
    "project-primary-keys": "Diagnostics.check_project_primary_keys",
    "project-auth-schema": "Diagnostics.check_project_auth_schema",
    "project-storage-schema": "Diagnostics.check_project_storage_schema",
    "project-fk-indexes": "Diagnostics.check_project_fk_indexes",
    "project-postgrest-health": "Diagnostics.check_project_postgrest_health",
    "project-schema-hash": "Diagnostics.check_project_schema_hash",
    "project-functiondef-hash": "Diagnostics.check_project_functiondef_hash",
    "project-trigger-hash": "Diagnostics.check_project_trigger_hash",
    "project-config-hash": "Diagnostics.check_project_config_hash",
    "platform-service-status": "Diagnostics.check_platform_service_status",
    "platform-port-listeners": "Diagnostics.check_platform_port_listeners",
    "platform-disk-space": "Diagnostics.check_platform_disk_space",
    "platform-api-health": "Diagnostics.check_platform_api_health",
    "platform-management-db": "Diagnostics.check_platform_management_db",
    "platform-project-state-consistency": "Diagnostics.check_platform_project_state_consistency",
    "platform-config-hash": "Diagnostics.check_platform_config_hash",
  };

  function severityClass(severity: DiagnosticCheck["severity"]) {
    if (severity === "critical") return "bg-red-500/10 text-red-700 border-red-500/20";
    if (severity === "warning") return "bg-amber-500/10 text-amber-700 border-amber-500/20";
    return "bg-blue-500/10 text-blue-700 border-blue-500/20";
  }

  function countResultsWithStatus(status: DiagnosticResult["status"]): number {
    return results.filter((result) => result.status === status).length;
  }

  function attentionCount(): number {
    return results.length - countResultsWithStatus("pass");
  }

  function notCheckedCount(): number {
    return Math.max(checks.length - results.length, 0);
  }

  function formatTime(timestamp: string | null) {
    if (!timestamp) return "-";
    return new Date(timestamp).toLocaleString();
  }

  function runLabel(run: DiagnosticRun): string {
    return $t("Diagnostics.run_label", { values: { time: formatTime(run.startedAt) } });
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
        {$t("Common.refresh")}
      </button>
      <button
        type="button"
        onclick={runDiagnostics}
        disabled={isLoading || isRunning}
        class="flex items-center gap-2 rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
      >
        {#if isRunning}<Loader2 size={14} class="animate-spin" />{:else}<ShieldCheck size={14} />{/if}
        {$t("Diagnostics.run_read_only")}
      </button>
    </div>
  </div>

  {#if error}
    <div class="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700">{error}</div>
  {/if}

  <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">{$t("Diagnostics.checks")}</div>
      <div class="mt-1 text-2xl font-bold">{checks.length}</div>
    </div>
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">{$t("Diagnostics.pass")}</div>
      <div class="mt-1 text-2xl font-bold text-emerald-600">{countResultsWithStatus("pass")}</div>
    </div>
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">{$t("Diagnostics.attention")}</div>
      <div class="mt-1 text-2xl font-bold text-red-600">{attentionCount()}</div>
      <p class="mt-1 text-[10px] text-muted-foreground">{$t("Diagnostics.tampered")}: {countResultsWithStatus("tampered")} · {$t("Diagnostics.degraded")}: {countResultsWithStatus("degraded")}</p>
    </div>
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">{$t("Diagnostics.not_checked")}</div>
      <div class="mt-1 text-2xl font-bold text-amber-600">{notCheckedCount()}</div>
    </div>
    <div class="rounded-md border bg-card p-3">
      <div class="text-[10px] font-bold uppercase text-muted-foreground">{$t("Diagnostics.last_run")}</div>
      <div class="mt-1 truncate text-xs font-semibold">{selectedRun ? formatTime(selectedRun.startedAt) : "-"}</div>
    </div>
  </div>

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
    <section class="rounded-md border bg-card">
      <div class="border-b px-4 py-3">
        <h2 class="text-sm font-semibold">{$t("Diagnostics.recent_runs")}</h2>
      </div>
      <div class="max-h-[560px] overflow-y-auto p-2">
        {#if runs.length === 0}
          <div class="px-3 py-10 text-center text-xs text-muted-foreground">{$t("Diagnostics.no_runs")}</div>
        {:else}
          {#each runs as run (run.id)}
            <button
              type="button"
              onclick={() => selectRun(run)}
              class="mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors {selectedRun?.id === run.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}"
            >
              <span class="min-w-0">
                <span class="block truncate font-medium" title={run.id}>{runLabel(run)}</span>
                <span class="mt-0.5 block truncate">{formatTime(run.startedAt)}</span>
              </span>
              <span title={run.status} class="rounded border px-1.5 py-0.5 text-[10px] uppercase">{runStatusLabel(run.status)}</span>
            </button>
          {/each}
        {/if}
      </div>
    </section>

    <section class="rounded-md border bg-card">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <h2 class="text-sm font-semibold">{$t("Diagnostics.results")}</h2>
        {#if selectedRun}
          <span class="text-xs text-muted-foreground" title={selectedRun.id}>{runLabel(selectedRun)}</span>
        {/if}
      </div>
      <div class="divide-y">
        {#if isLoading}
          <div class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 size={18} class="animate-spin" />
            {$t("Common.loading")}
          </div>
        {:else if results.length === 0}
          <div class="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            <FileCheck2 size={28} class="opacity-60" />
            <span class="text-sm">{$t("Diagnostics.no_results")}</span>
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
                      <span class="text-xs font-semibold" title={result.checkId}>{checkLabel(result.checkId)}</span>
                      <span class="rounded border px-1.5 py-0.5 text-[10px] font-bold {statusClass(result.status)}">{statusLabel(result.status)}</span>
                    </div>
                    {#if result.message || result.detail}
                      <details class="mt-2 text-[11px] text-muted-foreground">
                        <summary class="cursor-pointer select-none">{$t("Diagnostics.raw_details")}</summary>
                        <p class="mt-1 break-all font-mono">{result.message}</p>
                        {#if result.detail}<p class="mt-1 break-all font-mono">{result.detail}</p>{/if}
                      </details>
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
      <h2 class="text-sm font-semibold">{$t("Diagnostics.registered_checks")}</h2>
    </div>
    <div class="grid grid-cols-1 gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
      {#each checks as check (check.id)}
        <div class="rounded-md border bg-background p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <Database size={13} class="text-muted-foreground" />
                <span class="truncate text-xs font-semibold" title={check.id}>{checkLabel(check.id)}</span>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">{checkDescription(check)}</p>
            </div>
            <span title={check.severity} class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold {severityClass(check.severity)}">{$t(`Diagnostics.severity_${check.severity}`)}</span>
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>
