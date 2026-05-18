<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Loader2, HardDrive, Play, RotateCcw, Calendar, Clock, AlertTriangle, CheckCircle2, RefreshCw } from "lucide-svelte";

  import { useList, type BaseRecord } from "@svadmin/core";

  interface BackupInfo extends BaseRecord {
    id: string;
    type: string;
    status: string;
    timestamp: string;
    size: string;
    label: string;
  }

  const query = useList<BackupInfo>({ resource: "v1/projects/default/database/backups" });
  const backups = $derived(Array.isArray(query.data?.data) ? query.data.data : ((query.data?.data as unknown as Record<string, unknown>)?.backups as BackupInfo[] || []));

  let actionMsg: string | null = $state.raw(null);
  let isCreating = $state(false);
  let backupType = $state("incr");

  // PITR
  let showPitr = $state(false);
  let pitrDate = $state("");
  let pitrTime = $state("");
  let isRestoring = $state(false);

  const backupTypes = $derived([
    { v: "full", label: $t("PlatformBackups.full") || "Full", desc: $t("PlatformBackups.full_desc") || "" },
    { v: "incr", label: $t("PlatformBackups.incr") || "Incremental", desc: $t("PlatformBackups.incr_desc") || "" },
    { v: "diff", label: $t("PlatformBackups.diff") || "Differential", desc: $t("PlatformBackups.diff_desc") || "" },
  ]);

  function backupLabel(value: string) {
    return backupTypes.find((item) => item.v === value)?.label || value;
  }



  async function createBackup() {
    isCreating = true;
    actionMsg = null;
    try {
      const res = await apiClient("/v1/projects/default/database/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: backupType })
      });
      const data = await res.json();
      actionMsg = data.success !== false
        ? `✅ ${$t("PlatformBackups.backup_triggered")} (${backupLabel(backupType)})`
        : `❌ ${data.message || ($t("PlatformBackups.backup_failed") || "Backup failed")}`;
      query.refetch();
    } catch (err: unknown) {
      actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
    } finally {
      isCreating = false;
      setTimeout(() => actionMsg = null, 6000);
    }
  }

  async function restorePitr() {
    if (!pitrDate || !pitrTime) {
      actionMsg = `❌ ${$t("PlatformBackups.choose_datetime") || "Please choose a date and time"}`;
      return;
    }
    const target = `${pitrDate} ${pitrTime}`;
    if (!confirm(`⚠️ ${$t("PlatformBackups.restore_confirm", { values: { target } }) || `Restore database to ${target}?`}\n\n${$t("PlatformBackups.restore_warning") || "This will stop the database and roll back all later data. Continue?"}`)) return;

    isRestoring = true;
    actionMsg = null;
    try {
      const res = await apiClient("/v1/projects/default/database/backups/logical/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_time: target })
      });
      const data = await res.json();
      actionMsg = data.success !== false
        ? `✅ ${$t("PlatformBackups.restore_sent") || "PITR restore command sent"}`
        : `❌ ${data.message}`;
      showPitr = false;
    } catch (err: unknown) {
      actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
    } finally {
      isRestoring = false;
      setTimeout(() => actionMsg = null, 8000);
    }
  }



  function getStatusColor(status: string): string {
    if (status === "completed" || status === "ok") return "text-green-600 bg-green-500/10";
    if (status === "running" || status === "in_progress") return "text-amber-600 bg-amber-500/10 animate-pulse";
    return "text-red-600 bg-red-500/10";
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">{$t("PlatformBackups.title") || "Physical Backups & PITR"}</h2>
      <p class="text-xs text-muted-foreground mt-1">{$t("PlatformBackups.subtitle") || "pgBackRest based full/incremental backups and point-in-time recovery"}</p>
    </div>
    <button onclick={() => query.refetch()} disabled={query.isFetching} class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50">
      <RefreshCw size={12} class={query.isFetching ? 'animate-spin' : ''} /> {$t("Common.refresh")}
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
      <h3 class="text-sm font-semibold flex items-center gap-2"><HardDrive size={16} /> {$t("PlatformBackups.create_backup") || "Create Backup"}</h3>
    </div>
    <div class="p-5 flex items-end gap-4">
      <div class="flex-1">
        <label for="a11y-routes-platform-backups--page-svelte-120" class="text-xs font-semibold text-muted-foreground block mb-1.5">{$t("PlatformBackups.backup_type") || "Backup Type"}</label>
        <div class="flex gap-1 bg-muted/30 rounded-lg p-0.5 w-fit">
          {#each backupTypes as opt}
            <button
              class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors {backupType === opt.v ? 'bg-brand text-white' : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => backupType = opt.v}
            >{opt.label}</button>
          {/each}
        </div>
        <p class="text-[10px] text-muted-foreground mt-2">
          {#if backupType === "full"}{$t("PlatformBackups.full_desc") || "Full backup of the whole cluster, slowest but fastest restore."}{:else if backupType === "incr"}{$t("PlatformBackups.incr_desc") || "Back up only data changed since the last backup, fastest to run."}{:else}{$t("PlatformBackups.diff_desc") || "Back up all changes since the last full backup."}{/if}
        </p>
      </div>
      <button
        onclick={createBackup}
        disabled={isCreating}
        class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors flex items-center gap-2 disabled:opacity-50"
      >
        {#if isCreating}<Loader2 size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
        {$t("PlatformBackups.execute_backup") || "Run Backup"}
      </button>
    </div>
  </div>

  <!-- PITR Panel -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Clock size={16} /> {$t("PlatformBackups.pitr_title") || "Point-in-Time Recovery (PITR)"}</h3>
      <button onclick={() => showPitr = !showPitr} class="px-3 py-1 text-[10px] font-semibold rounded-md border hover:bg-muted/50 transition-colors">
        {showPitr ? ($t("PlatformBackups.collapse") || "Collapse") : ($t("PlatformBackups.expand") || "Expand")}
      </button>
    </div>
    {#if showPitr}
      <div class="p-5">
        <div class="rounded-lg border bg-red-500/5 border-red-500/20 p-3 mb-4 flex items-start gap-2">
          <AlertTriangle size={14} class="text-red-500 mt-0.5 shrink-0" />
          <p class="text-xs text-red-600">{$t("PlatformBackups.restore_warning") || "This is extremely dangerous. The database will be stopped and restored to the selected point in time, and all changes after that point will be permanently lost."}</p>
        </div>
        <div class="flex items-end gap-4">
          <div>
            <label for="a11y-routes-platform-backups--page-svelte-160" class="text-xs font-semibold text-muted-foreground block mb-1.5">{$t("PlatformBackups.restore_to_date") || "Restore to Date"}</label>
            <input id="a11y-routes-platform-backups--page-svelte-160" type="date" bind:value={pitrDate} class="px-3 py-2 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
          </div>
          <div>
            <label for="a11y-routes-platform-backups--page-svelte-164" class="text-xs font-semibold text-muted-foreground block mb-1.5">{$t("Common.time") || "Time"}</label>
            <input id="a11y-routes-platform-backups--page-svelte-164" type="time" step="1" bind:value={pitrTime} class="px-3 py-2 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
          </div>
          <button
            onclick={restorePitr}
            disabled={isRestoring}
            class="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {#if isRestoring}<Loader2 size={14} class="animate-spin" />{:else}<RotateCcw size={14} />{/if}
            {$t("PlatformBackups.execute_restore") || "Run Restore"}
          </button>
        </div>
      </div>
    {/if}
  </div>

  <!-- Backup History -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Calendar size={16} /> {$t("PlatformBackups.history") || "Backup History"}</h3>
    </div>
    {#if query.isLoading}
      <div class="flex items-center justify-center py-16">
        <Loader2 size={24} class="animate-spin text-brand opacity-50" />
      </div>
    {:else if backups.length === 0}
      <div class="p-8 text-center text-muted-foreground text-xs">{$t("PlatformBackups.no_history") || "No backup history yet. Run a backup above and it will appear here."}</div>
    {:else}
      <div class="overflow-auto max-h-80">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("PlatformBackups.label") || "Label"}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("PlatformBackups.type") || "Type"}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("PlatformBackups.status") || "Status"}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("PlatformBackups.time") || "Time"}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("PlatformBackups.size") || "Size"}</th>
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
