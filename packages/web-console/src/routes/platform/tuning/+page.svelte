<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { Loader2, SlidersHorizontal, Save, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-svelte";
  import { t, locale } from "svelte-i18n";
  let projectRef = $state("");
  async function resolveProjectRef() {
    try {
      const res = await apiClient("/v1/projects");
      const projects = await res.json();
      if (Array.isArray(projects) && projects.length > 0) {
        projectRef = projects[0].ref;
      }
    } catch {}
  }

  interface PgSetting {
    name: string;
    setting: string;
    unit: string | null;
    category: string;
    short_desc: string;
    context: string;
    vartype: string;
    min_val: string | null;
    max_val: string | null;
  }

  // Key tunable parameters grouped
  const TUNING_PARAMS = [
    { name: "shared_buffers", labelZh: "共享缓冲区", labelEn: "Shared Buffers", groupZh: "内存", groupEn: "Memory", descZh: "PostgreSQL 用于缓存表数据的内存大小", descEn: "Memory used by PostgreSQL to cache table data" },
    { name: "work_mem", labelZh: "工作内存", labelEn: "Work Mem", groupZh: "内存", groupEn: "Memory", descZh: "排序和哈希操作的工作内存", descEn: "Working memory for sort and hash operations" },
    { name: "maintenance_work_mem", labelZh: "维护内存", labelEn: "Maintenance Work Mem", groupZh: "内存", groupEn: "Memory", descZh: "VACUUM、CREATE INDEX 等维护操作的内存", descEn: "Memory used for maintenance operations like VACUUM and CREATE INDEX" },
    { name: "effective_cache_size", labelZh: "有效缓存大小", labelEn: "Effective Cache Size", groupZh: "内存", groupEn: "Memory", descZh: "操作系统和 PostgreSQL 缓存的总估计大小", descEn: "Estimated total cache available to the OS and PostgreSQL" },
    { name: "max_connections", labelZh: "最大连接数", labelEn: "Max Connections", groupZh: "连接", groupEn: "Connections", descZh: "允许的最大并发连接数", descEn: "Maximum number of concurrent connections allowed" },
    { name: "max_parallel_workers_per_gather", labelZh: "并行查询工作进程", labelEn: "Parallel Workers Per Gather", groupZh: "执行", groupEn: "Execution", descZh: "每个查询可使用的最大并行工作进程数", descEn: "Maximum parallel worker processes a single query can use" },
    { name: "random_page_cost", labelZh: "随机页面代价", labelEn: "Random Page Cost", groupZh: "执行", groupEn: "Execution", descZh: "随机 I/O 的相对代价估计（SSD 建议 1.1）", descEn: "Relative cost of random I/O (1.1 recommended for SSDs)" },
    { name: "effective_io_concurrency", labelZh: "I/O 并发度", labelEn: "I/O Concurrency", groupZh: "执行", groupEn: "Execution", descZh: "磁盘 I/O 并发请求数（SSD 建议 200）", descEn: "Concurrent disk I/O requests (200 recommended for SSDs)" },
    { name: "wal_buffers", labelZh: "WAL 缓冲区", labelEn: "WAL Buffers", groupZh: "WAL", groupEn: "WAL", descZh: "WAL 日志使用的共享内存", descEn: "Shared memory used by WAL" },
    { name: "checkpoint_completion_target", labelZh: "检查点完成目标", labelEn: "Checkpoint Completion Target", groupZh: "WAL", groupEn: "WAL", descZh: "检查点写入在间隔中的目标比例", descEn: "Target proportion of the checkpoint write interval" },
    { name: "log_min_duration_statement", labelZh: "慢查询阈值 (ms)", labelEn: "Slow Query Threshold (ms)", groupZh: "日志", groupEn: "Logging", descZh: "超过此耗时的语句将被记录（-1 禁用）", descEn: "Statements slower than this are logged (-1 disables)" },
  ];

  let settings: Record<string, PgSetting> = $state.raw({});
  let editValues: Record<string, string> = $state.raw({});
  let isLoading = $state(true);
  let isSaving = $state(false);
  let saveMsg: string | null = $state.raw(null);
  const isZh = $derived(($locale ?? "").toLowerCase().startsWith("zh"));
    
  function groupLabel(group: string) {
    const map: Record<string, string> = {
      "内存": "Memory",
      "连接": "Connections",
      "执行": "Execution",
      "WAL": "WAL",
      "日志": "Logging",
    };
    return isZh ? group : (map[group] || group);
  }

  function usesPageUnits(setting: PgSetting | undefined): boolean {
    return setting?.unit === "8kB";
  }

  function settingInputValue(setting: PgSetting): string {
    if (!usesPageUnits(setting) || setting.setting === "-1") return setting.setting;
    const pageCount = Number(setting.setting);
    return Number.isSafeInteger(pageCount) && pageCount >= 0 ? String(Math.round(pageCount / 128)) : setting.setting;
  }

  function settingInputUnit(setting: PgSetting | undefined, inputValue: string): string | null {
    if (!setting?.unit) return null;
    return usesPageUnits(setting) && inputValue !== "-1" ? "MB" : setting.unit;
  }

  function settingSqlValue(setting: PgSetting | undefined, inputValue: string): string | null {
    if (!usesPageUnits(setting) || inputValue === "-1") return inputValue;
    return /^\d+$/.test(inputValue) ? `${inputValue}MB` : null;
  }

  function sqlLiteral(literalValue: string): string {
    return literalValue.replaceAll("'", "''");
  }

  async function runSql(sql: string): Promise<Record<string, unknown>[]> {
    if (!projectRef || projectRef === "default") {
      await resolveProjectRef();
    }
    if (!projectRef || projectRef === "default") {
      return [];
    }
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql })
      });
      const data = await res.json();
      return data.rows || [];
    } catch { return []; }
  }

  async function fetchSettings() {
    isLoading = true;
    const names = TUNING_PARAMS.map(p => `'${p.name}'`).join(",");
    const rows = await runSql(`SELECT name, setting, unit, category, short_desc, context, vartype, min_val, max_val FROM pg_settings WHERE name IN (${names});`);
    const map: Record<string, PgSetting> = {};
    const vals: Record<string, string> = {};
    for (const row of rows) {
      const setting = row as unknown as PgSetting;
      map[setting.name] = setting;
      vals[setting.name] = settingInputValue(setting);
    }
    settings = map;
    editValues = vals;
    isLoading = false;
  }

  function changedSettingStatements(): string[] | null {
    const stmts: string[] = [];
    for (const param of TUNING_PARAMS) {
      const setting = settings[param.name];
      const current = setting ? settingInputValue(setting) : undefined;
      const newVal = editValues[param.name];
      if (newVal !== undefined && newVal !== current) {
        const sqlValue = settingSqlValue(setting, newVal);
        if (sqlValue === null) {
          return null;
        }
        stmts.push(`ALTER SYSTEM SET ${param.name} = '${sqlLiteral(sqlValue)}';`);
      }
    }
    return stmts;
  }

  async function saveAll() {
    isSaving = true;
    saveMsg = null;
    const stmts = changedSettingStatements();
    if (stmts === null) {
      saveMsg = `❌ ${$t("PlatformTuning.memory_value_invalid")}`;
      isSaving = false;
      return;
    }
    if (stmts.length === 0) {
      saveMsg = `⚠️ ${$t("PlatformTuning.no_parameter_changes_detected")}`;
      setTimeout(() => saveMsg = null, 3000);
      isSaving = false;
      return;
    }
    stmts.push("SELECT pg_reload_conf();");
    await runSql(stmts.join("\n"));
    saveMsg = `✅ ${$t("PlatformTuning.saved")} ${stmts.length - 1} ${$t("PlatformTuning.parameter_changes_and_reloaded_configuration")}`;
    await fetchSettings();
    isSaving = false;
    setTimeout(() => saveMsg = null, 5000);
  }

  onMount(async () => { await resolveProjectRef(); if (projectRef) await fetchSettings(); });

  const groups = $derived([...new Set(TUNING_PARAMS.map(p => p.groupZh))]);
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">{$t("PlatformTuning.engine_tuning")}</h2>
      <p class="text-xs text-muted-foreground mt-1">{$t("PlatformTuning.adjust_core_postgresql_runtime_parameters")}</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={() => fetchSettings()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <RefreshCw size={12} /> {$t("PlatformTuning.refresh")}
      </button>
      <button onclick={saveAll} disabled={isSaving} class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
        {#if isSaving}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
        {$t("PlatformTuning.save_changes")}
      </button>
    </div>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium {saveMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : saveMsg.startsWith('⚠') ? 'bg-amber-500/10 border-amber-500/20 text-amber-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">
      {saveMsg}
    </div>
  {/if}

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <SlidersHorizontal size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">{$t("PlatformTuning.after_editing_parameters_clicking_save_changes_will_execute")} <code class="px-1 py-0.5 rounded bg-blue-500/10">ALTER SYSTEM SET</code> {$t("PlatformTuning.and_call")} <code class="px-1 py-0.5 rounded bg-blue-500/10">pg_reload_conf()</code>。{$t("PlatformTuning.parameters_marked")} <span class="text-red-600 font-bold">{$t("PlatformTuning.restart_required")}</span> {$t("PlatformTuning.require_postgresql_restart_to_take")}</p>
  </div>

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    {#each groups as group}
      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="border-b px-5 py-3 bg-muted/20">
          <h3 class="text-sm font-semibold">{groupLabel(group)}</h3>
        </div>
        <div class="divide-y divide-border/20">
          {#each TUNING_PARAMS.filter(p => p.groupZh === group) as param}
            {@const s = settings[param.name]}
            {@const displayedValue = s ? settingInputValue(s) : ""}
            <div class="flex items-center justify-between px-5 py-4">
              <div class="flex-1">
                <div class="flex items-center gap-2">
                <span class="font-mono text-sm font-semibold">{param.name}</span>
                  {#if s?.context === "postmaster"}
                    <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-red-500/10 text-red-600 border border-red-500/20">{$t("PlatformTuning.restart_required_1")}</span>
                  {:else}
                    <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-green-500/10 text-green-600">{$t("PlatformTuning.hot_reload")}</span>
                  {/if}
                </div>
                <p class="text-[10px] text-muted-foreground mt-0.5">{isZh ? param.descZh : param.descEn}</p>
                {#if s}
                  <p class="text-[10px] text-muted-foreground/60 mt-0.5">{$t("PlatformTuning.current")}: <span class="font-mono">{displayedValue}{settingInputUnit(s, displayedValue) ? ` ${settingInputUnit(s, displayedValue)}` : ''}</span></p>
                {/if}
              </div>
              <div class="flex items-center gap-2">
                <div class="relative">
                  <input
                    bind:value={editValues[param.name]}
                    inputmode={usesPageUnits(s) ? "numeric" : "text"}
                    class="w-32 rounded-md border bg-muted/30 px-3 py-1.5 pr-12 text-right text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                  {#if settingInputUnit(s, editValues[param.name] || "")}
                    <span class="pointer-events-none absolute inset-y-0 right-0 flex items-center border-l bg-muted/40 px-2 text-[10px] font-mono text-muted-foreground">{settingInputUnit(s, editValues[param.name] || "")}</span>
                  {/if}
                </div>
                {#if editValues[param.name] !== displayedValue}
                  <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse" title={$t("PlatformTuning.modified")}></span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>
