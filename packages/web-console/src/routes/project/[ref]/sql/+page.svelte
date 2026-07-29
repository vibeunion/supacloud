<script lang="ts">
  import { apiClient } from "$lib/api";
  import {
    DatabaseSqlError,
    readDatabaseSqlCancellationResponse,
    readDatabaseSqlResponse,
  } from "$lib/database-sql-response";
  import { isSqlTabNameAvailable, nextSqlTabName } from "$lib/sql-tab-names";
  import { toast } from "svelte-sonner";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Play, Database, History, Shield, ChevronDown, Microscope, ChevronRight, Plus, X, CheckCircle2, Download } from "lucide-svelte";
  import { createMutation } from "@tanstack/svelte-query";

  interface QueryTab {
    id: string;
    name: string;
    sql: string;
    results: unknown[] | null;
    error: string | null;
    explainResults: unknown[] | null;
    command: string | null;
    statementCount: number | null;
    rowCount: number | null;
    durationMs: number | null;
  }

  interface SqlMutationVariables {
    rawSql: string;
    explainMode: boolean;
    tabId: string;
    queryId: string;
    startedAt: number;
  }

  let tabs = $state<QueryTab[]>([]);
  let activeTabId = $state("");
  let isSaving = $state(false);
  let isCancelling = $state(false);
  let saveTimeout: ReturnType<typeof setTimeout> | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let elapsedMs = $state(0);
  let activeQuery = $state<Pick<SqlMutationVariables, "tabId" | "queryId" | "startedAt"> | null>(null);
  let tabCounter = $state(1);

  // Explain mode state
  let explainMode = $state(false);

  // Role Impersonation state
  let selectedRole = $state("postgres");
  let showRoleMenu = $state(false);
  let customRoleInput = $state("");
  let showCustomInput = $state(false);

  const PRESET_ROLES = ["postgres", "anon", "authenticated", "service_role"];
  const ROLE_LABEL_KEYS: Record<string, string> = {
    postgres: "SqlEditor.role_default",
    anon: "SqlEditor.role_anon",
    authenticated: "SqlEditor.role_authenticated",
    service_role: "SqlEditor.role_service",
  };

  const projectRef = $derived(page.params.ref);
  const storageKey = $derived(`supacloud_${projectRef}_sql_tabs`);
  const isImpersonating = $derived(selectedRole !== "postgres");
  const activeTab = $derived(tabs.find(tb => tb.id === activeTabId));

  function createTab(name?: string, sqlContent?: string): QueryTab {
    const id = `tab_${Date.now()}_${tabCounter}`;
    tabCounter++;
    return {
      id,
      name: name?.trim() || nextSqlTabName(tabs, $t("SqlEditor.untitled_query")),
      sql: sqlContent || "",
      results: null,
      error: null,
      explainResults: null,
      command: null,
      statementCount: null,
      rowCount: null,
      durationMs: null,
    };
  }

  /** Format a cell value for display (Supabase Studio style) */
  function formatCellValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') {
      try { return JSON.stringify(value, null, 0); } catch { return String(value); }
    }
    return String(value);
  }

  /** Get CSS class for cell value type (dark-mode safe) */
  function getCellClass(value: unknown): string {
    if (value === null || value === undefined) return 'text-muted-foreground italic opacity-50';
    if (typeof value === 'boolean') return 'text-amber-600 dark:text-amber-400';
    if (typeof value === 'number') return 'text-blue-600 dark:text-blue-400';
    return '';
  }

  function addTab() {
    const tab = createTab();
    tabs = [...tabs, tab];
    activeTabId = tab.id;
  }

  function closeTab(id: string) {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex(tb => tb.id === id);
    tabs = tabs.filter(tb => tb.id !== id);
    if (activeTabId === id) {
      activeTabId = tabs[Math.max(0, idx - 1)].id;
    }
  }

  onMount(() => {
    // Load saved tabs
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          tabs = parsed;
          activeTabId = tabs[0].id;
        } else {
          throw new Error("empty");
        }
      } else {
        throw new Error("empty");
      }
    } catch {
      const initial = createTab();
      // Try migrate old single draft
      const oldKey = `supacloud_${projectRef}_sql_draft`;
      const oldDraft = localStorage.getItem(oldKey);
      if (oldDraft) {
        initial.sql = oldDraft;
        localStorage.removeItem(oldKey);
      }
      tabs = [initial];
      activeTabId = initial.id;
    }

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(".role-menu-container")) {
        showRoleMenu = false;
        showCustomInput = false;
      }
    }
    document.addEventListener("click", handleClickOutside);
    return () => {
      document.removeEventListener("click", handleClickOutside);
      clearTimeout(saveTimeout);
      clearInterval(elapsedTimer);
    };
  });

  function saveTabs() {
    isSaving = true;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      localStorage.setItem(storageKey, JSON.stringify(tabs));
      isSaving = false;
    }, 1000);
  }

  $effect(() => {
    if (tabs.length > 0) saveTabs();
  });

  function wrapWithRole(rawSql: string): string {
    if (selectedRole === "postgres") return rawSql;
    return `SET ROLE '${selectedRole}';\n${rawSql}\nRESET ROLE;`;
  }

  function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
    return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
  }

  function startElapsedTimer(): void {
    clearInterval(elapsedTimer);
    elapsedMs = 0;
    elapsedTimer = setInterval(() => {
      if (activeQuery) elapsedMs = performance.now() - activeQuery.startedAt;
    }, 100);
  }

  function stopElapsedTimer(): void {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  }

  function exportToCsv() {
    if (!activeTab?.results || activeTab.results.length === 0) return;
    
    const rows = activeTab.results as Record<string, unknown>[];
    const headers = Object.keys(rows[0]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => 
        headers.map(header => {
          let val = row[header];
          if (val === null || val === undefined) return '';
          if (typeof val === 'object') {
            try { val = JSON.stringify(val); } catch { val = String(val); }
          }
          const strVal = String(val).replace(/"/g, '""');
          return /[,\n"]/.test(strVal) ? `"${strVal}"` : strVal;
        }).join(',')
      )
    ].join('\n');
    
    // Add BOM for Excel UTF-8 compatibility
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `results_${projectRef}_${Date.now()}.csv`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const runQueryMutation = createMutation(() => ({
    mutationFn: async ({ rawSql, explainMode, queryId }: SqlMutationVariables) => {
      let queryToRun = rawSql;
      if (explainMode) {
        queryToRun = `EXPLAIN (ANALYZE, COSTS, VERBOSE, FORMAT TEXT) ${rawSql}`;
      }
      const wrappedSql = wrapWithRole(queryToRun);
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: wrappedSql, mode: "migration", query_id: queryId }),
        timeoutMs: 0,
      });
      return readDatabaseSqlResponse(res);
    },
    onMutate: (variables) => {
      activeQuery = variables;
      isCancelling = false;
      tabs = tabs.map(tab => tab.id === variables.tabId
        ? { ...tab, error: null, durationMs: null }
        : tab);
      startElapsedTimer();
    },
    onSuccess: (result, variables) => {
      tabs = tabs.map(tb => {
        if (tb.id !== variables.tabId) return tb;
        if (variables.explainMode) {
          return { ...tb, explainResults: result.rows, results: null, error: null, command: result.command, statementCount: result.statementCount, rowCount: result.rowCount, durationMs: result.durationMs };
        } else {
          return { ...tb, results: result.rows, explainResults: null, error: null, command: result.command, statementCount: result.statementCount, rowCount: result.rowCount, durationMs: result.durationMs };
        }
      });
    },
    onError: (error: unknown, variables) => {
      const durationMs = error instanceof DatabaseSqlError && error.durationMs !== null
        ? error.durationMs
        : Math.max(0, Math.round(performance.now() - variables.startedAt));
      const message = error instanceof DatabaseSqlError && error.code === "QUERY_CANCELLED"
        ? $t("SqlEditor.query_cancelled")
        : error instanceof Error ? error.message : String(error);
      tabs = tabs.map(tab => tab.id === variables.tabId
        ? { ...tab, error: message, results: null, explainResults: null, command: null, statementCount: null, rowCount: null, durationMs }
        : tab);
    },
    onSettled: () => {
      stopElapsedTimer();
      activeQuery = null;
      isCancelling = false;
    },
  }));

  function runQuery() {
    if (!activeTab || !activeTab.sql || runQueryMutation.isPending) return;
    runQueryMutation.mutate({
      rawSql: activeTab.sql,
      explainMode,
      tabId: activeTab.id,
      queryId: crypto.randomUUID(),
      startedAt: performance.now(),
    });
  }

  async function cancelQuery() {
    const runningQuery = activeQuery;
    if (!runningQuery || isCancelling) return;
    isCancelling = true;
    try {
      const response = await apiClient(
        `/v1/projects/${projectRef}/database/sql/${encodeURIComponent(runningQuery.queryId)}/cancel`,
        { method: "POST" },
      );
      await readDatabaseSqlCancellationResponse(response);
      toast.success($t("SqlEditor.cancel_confirmed"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : $t("SqlEditor.cancel_failed"));
    } finally {
      if (activeQuery?.queryId === runningQuery.queryId) isCancelling = false;
    }
  }

  function selectRole(role: string) {
    selectedRole = role;
    showRoleMenu = false;
    showCustomInput = false;
  }

  function submitCustomRole() {
    if (customRoleInput.trim()) {
      selectedRole = customRoleInput.trim();
      showRoleMenu = false;
      showCustomInput = false;
      customRoleInput = "";
    }
  }

  function getRoleLabel(role: string): string {
    const labelKey = ROLE_LABEL_KEYS[role];
    return labelKey ? $t(labelKey) : role;
  }

  function getSeverityColor(severity?: string): string {
    if (severity === "error") return "text-red-500";
    if (severity === "warning") return "text-amber-500";
    return "text-muted-foreground";
  }

  function sqlCommandLabel(command: string): string {
    return command === "BATCH" ? $t("SqlEditor.batch_command") : command;
  }

  function renameTab(id: string) {
    const tab = tabs.find(tb => tb.id === id);
    if (!tab) return;
    const newName = prompt($t("SqlEditor.rename_tab"), tab.name);
    const trimmedName = newName?.trim();
    if (!trimmedName) return;
    if (!isSqlTabNameAvailable(tabs, id, trimmedName)) {
      toast.error($t("SqlEditor.duplicate_tab_name"));
      return;
    }
    tabs = tabs.map(tb => tb.id === id ? { ...tb, name: trimmedName } : tb);
  }
</script>

<div class="h-[calc(100vh-12rem)] flex flex-col space-y-3">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <h1 class="text-2xl font-bold">{$t("SqlEditor.title")}</h1>
      <span class="px-2 py-0.5 bg-brand/10 text-brand text-[10px] font-mono rounded-full uppercase tracking-wider">{$t("SqlEditor.multi_tab_version")}</span>
    </div>
    <div class="flex items-center gap-3">
      {#if isSaving}
        <span class="text-[10px] text-muted-foreground animate-pulse">{$t("SqlEditor.syncing_draft")}</span>
      {:else}
        <span class="text-[10px] text-muted-foreground opacity-50">{$t("SqlEditor.local_synced")}</span>
      {/if}
      <button
        onclick={() => { explainMode = !explainMode; }}
        class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all border {explainMode ? 'bg-violet-500/10 border-violet-500/30 text-violet-600' : 'bg-muted/50 border-transparent text-muted-foreground hover:bg-muted'}"
      >
        <Microscope size={13} />
        {$t("SqlEditor.explain_mode")}
      </button>
      {#if runQueryMutation.isPending}
        <button
          onclick={cancelQuery}
          disabled={isCancelling}
          class="flex items-center gap-2 px-4 py-1.5 bg-destructive text-destructive-foreground text-xs font-semibold rounded-md shadow-lg hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 transition-all"
        >
          {#if isCancelling}
            <Loader2 size={14} class="animate-spin" />
            {$t("SqlEditor.cancelling")}
          {:else}
            <X size={14} />
            {$t("SqlEditor.cancel_query")} · {formatDuration(elapsedMs)}
          {/if}
        </button>
      {:else}
        <button
          onclick={runQuery}
          disabled={!activeTab?.sql}
          class="flex items-center gap-2 px-4 py-1.5 bg-brand text-white text-xs font-semibold rounded-md shadow-lg shadow-brand/20 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:grayscale transition-all"
        >
          <Play size={14} fill="currentColor" />
          {explainMode ? $t("SqlEditor.explain_analyze") : $t("SqlEditor.run_query")}
        </button>
      {/if}
    </div>
  </div>

  <!-- Tab Bar -->
  <div class="flex items-center gap-0.5 border-b border-border/50 overflow-x-auto">
    {#each tabs as tab (tab.id)}
      <div class="flex items-center group relative">
        <button
          onclick={() => activeTabId = tab.id}
          ondblclick={() => renameTab(tab.id)}
          class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap {activeTabId === tab.id ? 'border-brand text-foreground bg-muted/20' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10'}"
        >
          <Database size={11} class={activeTabId === tab.id ? 'text-brand' : 'opacity-50'} />
          {tab.name}
        </button>
        {#if tabs.length > 1}
          <button onclick={() => closeTab(tab.id)}
            class="absolute -right-0.5 top-1 p-0.5 rounded-sm hover:bg-destructive/10 hover:text-destructive text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            title={$t("SqlEditor.close_tab")}
          >
            <X size={10} />
          </button>
        {/if}
      </div>
    {/each}
    <button onclick={addTab} class="px-2 py-2 text-muted-foreground hover:text-foreground hover:bg-muted/20 rounded transition-colors" title={$t("SqlEditor.new_query")}>
      <Plus size={14} />
    </button>
  </div>

  <div class="flex-1 flex flex-col min-h-0 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    <!-- Editor Header -->
    <div class="flex items-center px-4 py-2 border-b bg-muted/30 gap-4">
      <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Database size={14} />
        <span>supabase_db</span>
      </div>
      <div class="h-3 w-[1px] bg-border"></div>
      <div class="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest">
        {$t("SqlEditor.database_engine")}
      </div>

      <div class="flex-1"></div>

      <!-- Role Impersonation Selector -->
      <div class="relative role-menu-container">
        <button
          onclick={() => { showRoleMenu = !showRoleMenu; }}
          class="flex items-center gap-2 px-3 py-1 rounded-md text-xs font-medium transition-all border {isImpersonating ? 'bg-amber-500/10 border-amber-500/30 text-amber-600' : 'bg-muted/50 border-transparent text-muted-foreground hover:bg-muted'}"
        >
          <Shield size={12} class={isImpersonating ? 'text-amber-500' : ''} />
          {#if isImpersonating}
            <span class="text-[9px] font-bold uppercase tracking-wider">{$t("SqlEditor.role_impersonation_active")}</span>
            <span class="font-mono">{selectedRole}</span>
          {:else}
            <span>{$t("SqlEditor.role_label")}: {getRoleLabel(selectedRole)}</span>
          {/if}
          <ChevronDown size={12} />
        </button>

        {#if showRoleMenu}
          <div class="absolute right-0 top-full mt-1 w-56 bg-popover rounded-lg border shadow-lg z-50 py-1 animate-in fade-in slide-in-from-top-2 duration-150">
            {#each PRESET_ROLES as role (role)}
              <button
                onclick={() => selectRole(role)}
                class="flex items-center gap-2 w-full px-4 py-2 text-xs text-left hover:bg-muted/50 transition-colors {selectedRole === role ? 'bg-muted/80 font-semibold text-brand' : 'text-foreground'}"
              >
                {#if selectedRole === role}
                  <div class="w-1.5 h-1.5 rounded-full bg-brand"></div>
                {:else}
                  <div class="w-1.5 h-1.5 rounded-full bg-transparent"></div>
                {/if}
                <span class="font-mono">{getRoleLabel(role)}</span>
              </button>
            {/each}
            <div class="h-px bg-border my-1"></div>
            {#if showCustomInput}
              <div class="px-3 py-2">
                <input
                  bind:value={customRoleInput}
                  onkeydown={(e) => { if (e.key === 'Enter') submitCustomRole(); }}
                  placeholder={$t("SqlEditor.role_custom")}
                  class="w-full px-2 py-1.5 text-xs font-mono rounded border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
 
                />
              </div>
            {:else}
              <button
                onclick={() => { showCustomInput = true; }}
                class="flex items-center gap-2 w-full px-4 py-2 text-xs text-left hover:bg-muted/50 transition-colors text-muted-foreground"
              >
                <div class="w-1.5 h-1.5 rounded-full bg-transparent"></div>
                <span>{$t("SqlEditor.role_custom")}</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- SQL Textarea -->
    <div class="flex-1 relative">
      {#if activeTab}
        <textarea
          bind:value={activeTab.sql}
          spellcheck="false"
          placeholder={$t("SqlEditor.placeholder")}
          class="absolute inset-0 w-full h-full p-6 bg-transparent font-mono text-sm resize-none focus:outline-none leading-relaxed selection:bg-brand/20"
          onkeydown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); } }}
        ></textarea>
      {/if}
    </div>

    <!-- Results/Error Section -->
    <div class="h-1/3 border-t flex flex-col bg-muted/5 min-h-[150px]">
      <div class="px-4 py-2 border-b flex items-center justify-between bg-muted/20">
        <div class="flex items-center gap-2">
          <span class="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{$t("SqlEditor.results")}</span>
          {#if isImpersonating}
            <span class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 text-[9px] font-bold uppercase">
              {selectedRole}
            </span>
          {/if}
          {#if activeTab?.durationMs !== null && activeTab?.durationMs !== undefined}
            <span class="text-[10px] text-muted-foreground tabular-nums">
              {$t("SqlEditor.duration")} {formatDuration(activeTab.durationMs)}
            </span>
          {/if}
        </div>
        {#if activeTab?.results}
          {#if activeTab.command && activeTab.results.length === 0}
            <span class="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold">
              ✓ {sqlCommandLabel(activeTab.command)} {$t("SqlEditor.complete")}
              {#if activeTab.statementCount && activeTab.statementCount > 1}
                · {activeTab.statementCount} {$t("SqlEditor.statements_executed")}
              {/if}
            </span>
          {:else}
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded-full bg-brand/10 text-brand text-[10px] font-bold tabular-nums">
                {activeTab.results.length} {$t("SqlEditor.rows_returned")}
              </span>
              {#if activeTab.results.length > 0}
                <button
                  onclick={exportToCsv}
                  class="p-1.5 hover:bg-muted/50 rounded-md text-muted-foreground hover:text-foreground transition-colors group relative"
                  title={$t("SqlEditor.export_csv")}
                >
                  <Download size={14} />
                </button>
              {/if}
            </div>
          {/if}
        {/if}
      </div>

      <div class="flex-1 overflow-auto p-4">
        {#if activeTab?.error}
          <div class="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">
            <strong>{$t("SqlEditor.execution_error")}</strong> {activeTab.error}
          </div>
        {:else if runQueryMutation.isPending && activeQuery?.tabId === activeTabId}
           <div class="h-full flex flex-col items-center justify-center text-muted-foreground gap-2 opacity-50">
             <Loader2 size={24} class="animate-spin text-brand" />
             <p class="text-[10px] uppercase font-bold tracking-[0.2em]">
               {$t("SqlEditor.executing")} {formatDuration(elapsedMs)}
             </p>
           </div>
        {:else if activeTab?.results && activeTab.results.length === 0 && activeTab.command}
          <!-- DDL/DML Success: No rows returned (matches Supabase Studio behavior) -->
          <div class="h-full flex flex-col items-center justify-center gap-3">
            <div class="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle2 size={24} class="text-emerald-500" />
            </div>
            <div class="text-center">
              <p class="text-sm font-semibold text-foreground">{$t("SqlEditor.success_no_rows")}</p>
              <p class="text-xs text-muted-foreground mt-1">
                <span class="font-mono px-1.5 py-0.5 rounded bg-muted text-[10px]" title={activeTab.command}>{sqlCommandLabel(activeTab.command)}</span>
                {#if activeTab.rowCount !== null && activeTab.rowCount > 0}
                  · {$t("SqlEditor.rows_affected", { values: { count: activeTab.rowCount } })}
                {/if}
              </p>
            </div>
          </div>
        {:else if activeTab?.results}
          <!-- Data Grid (Supabase Studio style) -->
          <div class="rounded border bg-background overflow-auto h-full">
            <table class="w-full text-left text-[11px] font-mono border-collapse min-w-max">
              <thead class="bg-muted/60 dark:bg-muted/30 border-b border-border sticky top-0 z-10">
                <tr>
                  <th class="px-2 py-2 font-bold text-muted-foreground/60 text-center border-r border-border/40 w-12 bg-muted/60 dark:bg-muted/30">#</th>
                  {#if activeTab.results.length > 0}
                    {#each Object.keys(activeTab.results[0] as Record<string, unknown>) as key (key)}
                      <th class="px-3 py-2 font-semibold text-foreground/70 border-r border-border/40 whitespace-nowrap bg-muted/60 dark:bg-muted/30">{key}</th>
                    {/each}
                  {/if}
                </tr>
              </thead>
              <tbody class="divide-y divide-border/30 dark:divide-border/20">
                {#each activeTab.results as row, idx (`${idx}-${JSON.stringify(row)}`)}
                  <tr class="hover:bg-muted/30 dark:hover:bg-muted/10 transition-colors group">
                    <td class="px-2 py-1.5 text-center text-muted-foreground/50 border-r border-border/30 dark:border-border/20 tabular-nums select-none text-[10px]">{idx + 1}</td>
                    {#each Object.values(row as Record<string, unknown>) as value, valueIndex (`${idx}-${valueIndex}`)}
                      <td class="px-3 py-1.5 border-r border-border/20 dark:border-border/10 max-w-[300px] truncate {getCellClass(value)}" title={formatCellValue(value)}>
                        {formatCellValue(value)}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if activeTab?.explainResults}
          <!-- Explain Visualizer -->
          <div class="space-y-0 font-mono text-xs">
            {#each activeTab.explainResults as row, idx (`${idx}-${String((row as Record<string, unknown>)["QUERY PLAN"] || "")}`)}
              {@const planLine = String((row as Record<string, unknown>)["QUERY PLAN"] || Object.values(row as Record<string, unknown>)[0] || "")}
              {@const indent = planLine.match(/^(\s*)/)?.[1]?.length || 0}
              {@const isSeqScan = planLine.toLowerCase().includes("seq scan")}
              {@const isIndexScan = planLine.toLowerCase().includes("index")}
              {@const isSort = planLine.toLowerCase().includes("sort")}
              {@const isHash = planLine.toLowerCase().includes("hash")}
              {@const isTime = planLine.includes("Planning Time") || planLine.includes("Execution Time")}
              {@const borderColor = isSeqScan ? 'border-l-amber-500' : isIndexScan ? 'border-l-green-500' : isSort ? 'border-l-blue-500' : isHash ? 'border-l-purple-500' : isTime ? 'border-l-transparent' : 'border-l-muted-foreground/20'}
              <div class="flex items-stretch border-l-[3px] {borderColor} hover:bg-muted/20 transition-colors" style:padding-left="{Math.max(indent * 4, 8)}px">
                <div class="py-1.5 px-2 flex-1 min-w-0">
                  <span class="{isTime ? 'text-brand font-semibold' : isSeqScan ? 'text-amber-600' : isIndexScan ? 'text-green-600' : 'text-foreground/80'}">{planLine.trim().replace(/^->\s*/, '')}</span>
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <div class="h-full flex flex-col items-center justify-center text-muted-foreground gap-2 opacity-30">
            <History size={32} strokeWidth={1} />
            <p class="text-xs italic">{$t("SqlEditor.run_shortcut")}</p>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
