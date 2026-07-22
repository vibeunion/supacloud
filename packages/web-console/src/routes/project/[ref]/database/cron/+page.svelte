<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Clock, CalendarClock, CheckCircle2, XCircle, AlertCircle, Plus, Trash2, X } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface CronJob {
    jobid: number;
    schedule: string;
    command: string;
    nodename: string;
    nodeport: number;
    database: string;
    username: string;
    active: boolean;
    jobname: string;
  }

  interface CronRun {
    runid: number;
    jobid: number;
    job_pid: number;
    database: string;
    username: string;
    command: string;
    status: string;
    return_message: string;
    start_time: string;
    end_time: string;
  }

  const queryClient = useQueryClient();

  // Scheduler state
  let showAdd = $state(false);
  let isSaving = $state(false);
  let actionError = $state<string | null>(null);
  let newName = $state("");
  let newSchedule = $state("* * * * *");
  let newCommand = $state("VACUUM analyze;");

  const projectRef = $derived(page.params.ref);

  const CRON_EXTENSION_SQL = `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS installed;`;
  const JOBS_SQL = `SELECT * FROM cron.job ORDER BY jobid;`;
  const RUNS_SQL = `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 50;`;

  const cronQuery = createQuery(() => ({
    queryKey: ["database_cron", projectRef],
    queryFn: async () => {
      const extensionRes = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: CRON_EXTENSION_SQL })
      });
      const extensionData = await extensionRes.json();
      if (!extensionRes.ok || extensionData.error) {
        return { jobs: [], runs: [], unavailable: extensionData.message || extensionData.error || "pg_cron 状态不可用" };
      }
      if (!extensionData.rows?.[0]?.installed) {
        return { jobs: [], runs: [], unavailable: "pg_cron 未安装" };
      }

      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: JOBS_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      const jobs = data.rows || [];

      let runs: CronRun[] = [];
      try {
        const res2 = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: RUNS_SQL })
        });
        const data2 = await res2.json();
        if (!data2.error) {
          runs = data2.rows || [];
        }
      } catch (e) {
        // Run details might not be present or accessible
      }
      return { jobs, runs };
    }
  }));

  const jobs = $derived(cronQuery.data?.jobs || []);
  const runs = $derived(cronQuery.data?.runs || []);
  const isLoading = $derived(cronQuery.isPending);
  const error = $derived(cronQuery.error?.message || null);
  const unavailableMsg = $derived(cronQuery.data?.unavailable || null);
  const fallbackMsg = $derived(!isLoading && !error && jobs.length === 0 ? (unavailableMsg || "暂无定时任务") : null);

  const createJobMutation = createMutation(() => ({
    mutationFn: async () => {
      const sql = `SELECT cron.schedule('${newName.replace(/'/g,"''")}', '${newSchedule.replace(/'/g,"''")}', '${newCommand.replace(/'/g,"''")}');`;
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return data;
    },
    onSuccess: () => {
      showAdd = false; newName = ""; newSchedule = "* * * * *"; newCommand = "";
      queryClient.invalidateQueries({ queryKey: ["database_cron", projectRef] });
    },
    onError: (err: unknown) => {
      actionError = (err instanceof Error ? err.message : String(err)) || "创建任务失败";
    }
  }));

  async function createJob() {
    if (!newName || !newSchedule || !newCommand) { actionError = "请完整填写所有必填字段"; return; }
    actionError = null;
    createJobMutation.mutate();
  }

  const deleteJobMutation = createMutation(() => ({
    mutationFn: async (jobId: number) => {
      const sql = `SELECT cron.unschedule(${jobId});`;
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["database_cron", projectRef] });
    },
    onError: (err: unknown) => {
      alert("取消排程失败: " + (err instanceof Error ? err.message : String(err)));
    }
  }));

  async function deleteJob(jobId: number, jobName: string) {
    if (!confirm(`确定取消任务 "${jobName}" (#${jobId}) 的排程吗？`)) return;
    deleteJobMutation.mutate(jobId);
  }

  function formatTime(ts: string): string {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("CronJobs.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("CronJobs.subtitle")}</p>
    </div>
    <div class="flex items-center gap-3">
      <span class="px-2.5 py-1 rounded-full bg-brand/10 text-brand text-xs font-bold">{jobs.length} 个任务</span>
      <button 
        onclick={() => showAdd = !showAdd}
        disabled={Boolean(unavailableMsg)}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
      >
        <Plus size={14} /> 新建任务
      </button>
    </div>
  </div>

  {#if showAdd}
    <div class="rounded-xl border bg-card p-5 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold">新建 Cron 任务 (pg_cron)</h3>
        <button onclick={() => showAdd = false} class="text-muted-foreground hover:text-foreground"><X size={16} /></button>
      </div>
      {#if actionError}
        <div class="p-2 border border-red-500/20 bg-red-500/10 text-red-600 text-xs rounded">{actionError}</div>
      {/if}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <span class="text-xs text-muted-foreground font-semibold">任务名称 (需唯一)</span>
          <input type="text" bind:value={newName} placeholder="例如：nightly_vacuum"
            class="w-full mt-1.5 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand font-mono" />
        </div>
        <div>
          <span class="text-xs text-muted-foreground font-semibold">Cron 表达式</span>
          <input type="text" bind:value={newSchedule} placeholder="* * * * *"
            class="w-full mt-1.5 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand font-mono" />
        </div>
        <div class="md:col-span-2">
          <span class="text-xs text-muted-foreground font-semibold">执行命令 (SQL)</span>
          <textarea bind:value={newCommand} placeholder="例如：VACUUM ANALYZE;" rows="3"
            class="w-full mt-1.5 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand font-mono"></textarea>
        </div>
      </div>
      <div class="flex justify-end gap-3 pt-2">
        <button onclick={() => showAdd = false} class="px-4 py-2 text-xs font-medium rounded-lg hover:bg-muted/50 transition-colors">取消</button>
        <button onclick={createJob} disabled={createJobMutation.isPending || !newName || !newCommand} 
          class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
          {#if createJobMutation.isPending}<Loader2 size={12} class="animate-spin" />{/if} 确认排程
        </button>
      </div>
    </div>
  {/if}


  {#if isLoading}
    <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
      <p class="text-xs font-mono uppercase tracking-widest">{$t("CronJobs.loading")}</p>
    </div>
  {:else if error}
    <div class="p-4"><div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div></div>
  {:else if fallbackMsg}
    <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-4 opacity-40">
      <CalendarClock size={48} strokeWidth={1} />
      <p class="text-sm">{fallbackMsg}</p>
    </div>
  {:else}
    <!-- Jobs Table -->
    <div>
      <h2 class="text-sm font-semibold mb-2 flex items-center gap-2">
        <Clock size={14} class="text-brand" />
        {$t("CronJobs.title")} ({jobs.length})
      </h2>
      <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
        <div class="overflow-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b sticky top-0">
              <tr>
                <th class="px-4 py-2.5 font-semibold text-muted-foreground">ID</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("CronJobs.name")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("CronJobs.schedule")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("CronJobs.command")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("CronJobs.database")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("CronJobs.active")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20">
              {#each jobs as job}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2.5 font-mono text-muted-foreground">{job.jobid}</td>
                  <td class="px-3 py-2.5 font-medium">{job.jobname || "—"}</td>
                  <td class="px-3 py-2.5">
                    <span class="px-2 py-0.5 rounded bg-violet-500/10 text-violet-600 font-mono text-[10px] font-bold">{job.schedule}</span>
                  </td>
                  <td class="px-3 py-2.5 font-mono text-[11px] text-muted-foreground max-w-xs truncate">{job.command}</td>
                  <td class="px-3 py-2.5 font-mono text-muted-foreground">{job.database}</td>
                  <td class="px-3 py-2.5 text-center">
                    <div class="flex items-center justify-center gap-2">
                      {#if job.active}
                        <span title="活跃"><CheckCircle2 size={14} class="text-green-500" /></span>
                      {:else}
                        <span title="非活跃"><XCircle size={14} class="text-muted-foreground/30" /></span>
                      {/if}
                      <button onclick={() => deleteJob(job.jobid, job.jobname)} 
                        class="p-1 rounded text-muted-foreground hover:bg-red-500/10 hover:text-red-500 transition-colors" title="取消排程">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Recent Runs -->
    {#if runs.length > 0}
      <div>
        <h2 class="text-sm font-semibold mb-2 flex items-center gap-2">
          <AlertCircle size={14} class="text-muted-foreground" />
          {$t("CronJobs.last_run")} (最近 {runs.length} 条)
        </h2>
        <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
          <div class="overflow-auto max-h-64">
            <table class="w-full text-left text-xs">
              <thead class="bg-muted/30 border-b sticky top-0">
                <tr>
                  <th class="px-3 py-2 font-semibold text-muted-foreground">Job ID</th>
                  <th class="px-3 py-2 font-semibold text-muted-foreground">{$t("CronJobs.command")}</th>
                  <th class="px-3 py-2 font-semibold text-muted-foreground">{$t("CronJobs.status")}</th>
                  <th class="px-3 py-2 font-semibold text-muted-foreground">Start</th>
                  <th class="px-3 py-2 font-semibold text-muted-foreground">Message</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border/20">
                {#each runs as run}
                  <tr class="hover:bg-muted/10 transition-colors">
                    <td class="px-3 py-2 font-mono text-muted-foreground">{run.jobid}</td>
                    <td class="px-3 py-2 font-mono text-[10px] text-muted-foreground max-w-xs truncate">{run.command}</td>
                    <td class="px-3 py-2">
                      <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase {run.status === 'succeeded' ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-500'}">{run.status}</span>
                    </td>
                    <td class="px-3 py-2 text-muted-foreground text-[10px]">{formatTime(run.start_time)}</td>
                    <td class="px-3 py-2 text-muted-foreground text-[10px] max-w-xs truncate">{run.return_message || "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
