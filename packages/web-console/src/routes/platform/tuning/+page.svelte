<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { Loader2, SlidersHorizontal, Save, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-svelte";

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
    { name: "shared_buffers", label: "共享缓冲区", group: "内存", desc: "PostgreSQL 用于缓存表数据的内存大小" },
    { name: "work_mem", label: "工作内存", group: "内存", desc: "排序和哈希操作的工作内存" },
    { name: "maintenance_work_mem", label: "维护内存", group: "内存", desc: "VACUUM、CREATE INDEX 等维护操作的内存" },
    { name: "effective_cache_size", label: "有效缓存大小", group: "内存", desc: "操作系统和 PostgreSQL 缓存的总估计大小" },
    { name: "max_connections", label: "最大连接数", group: "连接", desc: "允许的最大并发连接数（需重启）" },
    { name: "max_parallel_workers_per_gather", label: "并行查询工人数", group: "执行", desc: "每个查询可使用的最大并行工人数" },
    { name: "random_page_cost", label: "随机页面代价", group: "执行", desc: "随机 I/O 的相对代价估计（SSD 建议 1.1）" },
    { name: "effective_io_concurrency", label: "I/O 并发度", group: "执行", desc: "磁盘 I/O 并发请求数（SSD 建议 200）" },
    { name: "wal_buffers", label: "WAL 缓冲区", group: "WAL", desc: "WAL 日志使用的共享内存" },
    { name: "checkpoint_completion_target", label: "检查点完成目标", group: "WAL", desc: "检查点写入间隔的百分比（建议 0.9）" },
    { name: "log_min_duration_statement", label: "慢查询阈值 (ms)", group: "日志", desc: "超过此耗时的语句将被记录（-1 禁用）" },
  ];

  let settings: Record<string, PgSetting> = $state.raw({});
  let editValues: Record<string, string> = $state.raw({});
  let isLoading = $state(true);
  let isSaving = $state(false);
  let saveMsg: string | null = $state.raw(null);

  async function runSql(sql: string): Promise<Record<string, unknown>[]> {
    try {
      const res = await apiClient("/v1/projects/default/database/sql", {
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
      map[row.name as string] = row as unknown as PgSetting;
      vals[row.name as string] = row.setting as string;
    }
    settings = map;
    editValues = vals;
    isLoading = false;
  }

  async function saveAll() {
    isSaving = true;
    saveMsg = null;
    const stmts: string[] = [];
    for (const param of TUNING_PARAMS) {
      const current = settings[param.name]?.setting;
      const newVal = editValues[param.name];
      if (newVal !== undefined && newVal !== current) {
        stmts.push(`ALTER SYSTEM SET ${param.name} = '${newVal}';`);
      }
    }
    if (stmts.length === 0) {
      saveMsg = "⚠️ 没有检测到任何参数变更";
      setTimeout(() => saveMsg = null, 3000);
      isSaving = false;
      return;
    }
    stmts.push("SELECT pg_reload_conf();");
    const result = await runSql(stmts.join("\n"));
    saveMsg = `✅ 已保存 ${stmts.length - 1} 项参数变更并重载配置`;
    await fetchSettings();
    isSaving = false;
    setTimeout(() => saveMsg = null, 5000);
  }

  onMount(() => fetchSettings());

  const groups = $derived([...new Set(TUNING_PARAMS.map(p => p.group))]);
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">引擎参数调优</h2>
      <p class="text-xs text-muted-foreground mt-1">直接调整 PostgreSQL 核心运行参数（ALTER SYSTEM SET）</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={() => fetchSettings()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <RefreshCw size={12} /> 刷新
      </button>
      <button onclick={saveAll} disabled={isSaving} class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
        {#if isSaving}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
        保存变更
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
    <p class="text-xs text-blue-700">修改参数后点击「保存变更」将执行 <code class="px-1 py-0.5 rounded bg-blue-500/10">ALTER SYSTEM SET</code> 并调用 <code class="px-1 py-0.5 rounded bg-blue-500/10">pg_reload_conf()</code>。标注 <span class="text-red-600 font-bold">(需重启)</span> 的参数需要重启 PostgreSQL 才能生效。</p>
  </div>

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={24} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    {#each groups as group}
      <div class="rounded-xl border bg-card overflow-hidden">
        <div class="border-b px-5 py-3 bg-muted/20">
          <h3 class="text-sm font-semibold">{group}</h3>
        </div>
        <div class="divide-y divide-border/20">
          {#each TUNING_PARAMS.filter(p => p.group === group) as param}
            {@const s = settings[param.name]}
            <div class="flex items-center justify-between px-5 py-4">
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-sm font-semibold">{param.name}</span>
                  {#if s?.context === "postmaster"}
                    <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-red-500/10 text-red-600 border border-red-500/20">需重启</span>
                  {:else}
                    <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-green-500/10 text-green-600">热加载</span>
                  {/if}
                </div>
                <p class="text-[10px] text-muted-foreground mt-0.5">{param.desc}</p>
                {#if s}
                  <p class="text-[10px] text-muted-foreground/60 mt-0.5">当前值: <span class="font-mono">{s.setting}{s.unit ? ` ${s.unit}` : ''}</span></p>
                {/if}
              </div>
              <div class="flex items-center gap-2">
                <input
                  bind:value={editValues[param.name]}
                  class="w-32 px-3 py-1.5 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand text-right"
                />
                {#if s?.unit}
                  <span class="text-[10px] text-muted-foreground font-mono w-8">{s.unit}</span>
                {/if}
                {#if editValues[param.name] !== s?.setting}
                  <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse" title="已修改"></span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>
