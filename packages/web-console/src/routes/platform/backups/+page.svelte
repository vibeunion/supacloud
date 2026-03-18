<script lang="ts">
  import { onMount } from "svelte";
  import { Loader2, HardDrive, Play, RotateCcw, Calendar, Clock, AlertTriangle, CheckCircle2, RefreshCw } from "lucide-svelte";

  interface BackupInfo {
    id: string;
    type: string;
    status: string;
    timestamp: string;
    size: string;
    label: string;
  }

  let backups: BackupInfo[] = $state([]);
  let isLoading = $state(true);
  let actionMsg: string | null = $state(null);
  let isCreating = $state(false);
  let backupType = $state("incr");

  // PITR
  let showPitr = $state(false);
  let pitrDate = $state("");
  let pitrTime = $state("");
  let isRestoring = $state(false);

  async function fetchBackups() {
    isLoading = true;
    try {
      const res = await fetch("/v1/projects/default/database/backups");
      if (res.ok) {
        const data = await res.json();
        backups = Array.isArray(data) ? data : data.backups || [];
      }
    } catch {}
    isLoading = false;
  }

  async function createBackup() {
    isCreating = true;
    actionMsg = null;
    try {
      const res = await fetch("/v1/projects/default/database/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: backupType })
      });
      const data = await res.json();
      actionMsg = data.success !== false ? `✅ 物理备份已触发 (${backupType})` : `❌ ${data.message || '备份失败'}`;
      await fetchBackups();
    } catch (err: any) {
      actionMsg = `❌ ${err.message}`;
    } finally {
      isCreating = false;
      setTimeout(() => actionMsg = null, 6000);
    }
  }

  async function restorePitr() {
    if (!pitrDate || !pitrTime) {
      actionMsg = "❌ 请选择日期和时间";
      return;
    }
    const target = `${pitrDate} ${pitrTime}`;
    if (!confirm(`⚠️ 危险操作：将数据库恢复到 ${target}\n\n这将停止数据库并回退所有后续数据，确定继续？`)) return;

    isRestoring = true;
    actionMsg = null;
    try {
      const res = await fetch("/v1/projects/default/database/backups/logical/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_time: target })
      });
      const data = await res.json();
      actionMsg = data.success !== false ? "✅ PITR 恢复命令已发送" : `❌ ${data.message}`;
      showPitr = false;
    } catch (err: any) {
      actionMsg = `❌ ${err.message}`;
    } finally {
      isRestoring = false;
      setTimeout(() => actionMsg = null, 8000);
    }
  }

  onMount(() => fetchBackups());

  function getStatusColor(status: string): string {
    if (status === "completed" || status === "ok") return "text-green-600 bg-green-500/10";
    if (status === "running" || status === "in_progress") return "text-amber-600 bg-amber-500/10 animate-pulse";
    return "text-red-600 bg-red-500/10";
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">物理备份 & PITR</h2>
      <p class="text-xs text-muted-foreground mt-1">基于 pgBackRest 的全量/增量物理备份与任意时间点恢复</p>
    </div>
    <button onclick={() => fetchBackups()} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
      <RefreshCw size={12} /> 刷新
    </button>
  </div>

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  <!-- Create Backup -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold flex items-center gap-2"><HardDrive size={16} /> 创建物理备份</h3>
    </div>
    <div class="p-5 flex items-end gap-4">
      <div class="flex-1">
        <label class="text-xs font-semibold text-muted-foreground block mb-1.5">备份类型</label>
        <div class="flex gap-1 bg-muted/30 rounded-lg p-0.5 w-fit">
          {#each [{ v: "full", label: "全量 (Full)" }, { v: "incr", label: "增量 (Incr)" }, { v: "diff", label: "差异 (Diff)" }] as opt}
            <button
              class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors {backupType === opt.v ? 'bg-brand text-white' : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => backupType = opt.v}
            >{opt.label}</button>
          {/each}
        </div>
        <p class="text-[10px] text-muted-foreground mt-2">
          {#if backupType === "full"}全量备份整个数据库集群，耗时最长但恢复最快{:else if backupType === "incr"}仅备份自上次备份以来变更的数据，速度最快{:else}备份自上次全量以来的所有变更{/if}
        </p>
      </div>
      <button
        onclick={createBackup}
        disabled={isCreating}
        class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors flex items-center gap-2 disabled:opacity-50"
      >
        {#if isCreating}<Loader2 size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
        执行备份
      </button>
    </div>
  </div>

  <!-- PITR Panel -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Clock size={16} /> 时间点恢复 (PITR)</h3>
      <button onclick={() => showPitr = !showPitr} class="px-3 py-1 text-[10px] font-semibold rounded-md border hover:bg-muted/50 transition-colors">
        {showPitr ? '收起' : '展开恢复面板'}
      </button>
    </div>
    {#if showPitr}
      <div class="p-5">
        <div class="rounded-lg border bg-red-500/5 border-red-500/20 p-3 mb-4 flex items-start gap-2">
          <AlertTriangle size={14} class="text-red-500 mt-0.5 shrink-0" />
          <p class="text-xs text-red-600">此操作极其危险！将停止数据库并恢复到指定时间点，恢复后所有该时间点之后的变更将永久丢失。</p>
        </div>
        <div class="flex items-end gap-4">
          <div>
            <label class="text-xs font-semibold text-muted-foreground block mb-1.5">恢复到日期</label>
            <input type="date" bind:value={pitrDate} class="px-3 py-2 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
          </div>
          <div>
            <label class="text-xs font-semibold text-muted-foreground block mb-1.5">时间</label>
            <input type="time" step="1" bind:value={pitrTime} class="px-3 py-2 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
          </div>
          <button
            onclick={restorePitr}
            disabled={isRestoring}
            class="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {#if isRestoring}<Loader2 size={14} class="animate-spin" />{:else}<RotateCcw size={14} />{/if}
            执行恢复
          </button>
        </div>
      </div>
    {/if}
  </div>

  <!-- Backup History -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Calendar size={16} /> 备份历史</h3>
    </div>
    {#if isLoading}
      <div class="flex items-center justify-center py-16">
        <Loader2 size={24} class="animate-spin text-brand opacity-50" />
      </div>
    {:else if backups.length === 0}
      <div class="p-8 text-center text-muted-foreground text-xs">暂无备份历史记录。执行上方备份操作后会在此显示。</div>
    {:else}
      <div class="overflow-auto max-h-80">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">标签</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">类型</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">状态</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">时间</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">大小</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each backups as b}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5 font-mono font-medium">{b.label || b.id}</td>
                <td class="px-3 py-2.5 font-mono">{b.type}</td>
                <td class="px-3 py-2.5">
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold {getStatusColor(b.status)}">{b.status}</span>
                </td>
                <td class="px-3 py-2.5 text-muted-foreground">{b.timestamp}</td>
                <td class="px-3 py-2.5 text-muted-foreground font-mono">{b.size || '-'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
