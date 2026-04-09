<script lang="ts">
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { Loader2, RefreshCw, Activity, TerminalSquare, CheckCircle2, AlertCircle, Clock } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import dayjs from "dayjs";

  const projectRef = $derived(page.params.ref);

  let tasks = $state<any[]>([]);
  let isLoading = $state(true);
  let isRefreshing = $state(false);

  async function fetchTasks(silent = false) {
    if (!silent) isLoading = true;
    else isRefreshing = true;

    try {
      const res = await fetch(`/api/query?path=/v1/projects/${projectRef}/tasks`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "获取任务列表失败");
      tasks = data || [];
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      isLoading = false;
      isRefreshing = false;
    }
  }

  onMount(() => {
    fetchTasks();
  });

  function getStatusIcon(status: string) {
    switch (status) {
      case 'completed': return CheckCircle2;
      case 'error': return AlertCircle;
      case 'processing': return Loader2;
      default: return Clock;
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'completed': return "text-emerald-500 bg-emerald-500/10 border-emerald-500/20";
      case 'error': return "text-red-500 bg-red-500/10 border-red-500/20";
      case 'processing': return "text-blue-500 bg-blue-500/10 border-blue-500/20";
      default: return "text-amber-500 bg-amber-500/10 border-amber-500/20";
    }
  }
</script>

<div class="h-full flex flex-col space-y-6 max-w-6xl mx-auto py-6 px-8">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
        <Activity class="w-6 h-6 text-brand" />
        后台任务队列
      </h1>
      <p class="text-sm text-muted-foreground mt-1">观测并追踪后台 AI 生成、边缘函数及长短周期基础设施队列任务的执行状态。</p>
    </div>
    
    <button
      onclick={() => fetchTasks(true)}
      disabled={isRefreshing || isLoading}
      class="flex items-center gap-2 px-4 py-2 border rounded-lg bg-card hover:bg-muted/50 transition-colors text-sm font-medium disabled:opacity-50"
    >
      <RefreshCw size={16} class={isRefreshing ? "animate-spin" : ""} />
      刷新列表
    </button>
  </div>

  <div class="border rounded-xl bg-card overflow-hidden flex-1 flex flex-col shadow-sm">
    {#if isLoading && tasks.length === 0}
      <div class="flex-1 flex items-center justify-center p-24">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
      </div>
    {:else if tasks.length === 0}
      <div class="flex-1 flex flex-col items-center justify-center p-24 text-center">
        <div class="w-16 h-16 rounded-full bg-muted/30 flex items-center justify-center mb-4 text-muted-foreground">
          <TerminalSquare size={32} />
        </div>
        <h3 class="text-lg font-medium text-foreground">暂无后台任务</h3>
        <p class="text-sm text-muted-foreground mt-1 max-w-sm">
          当通过模型触发流式生成、或是调用队列下发系统事件时，这里会展示所有任务的日志。
        </p>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm text-left">
          <thead class="bg-muted/30 text-xs uppercase text-muted-foreground border-b border-border/50">
            <tr>
              <th class="px-6 py-4 font-semibold">任务 ID</th>
              <th class="px-6 py-4 font-semibold">任务类型 (Type)</th>
              <th class="px-6 py-4 font-semibold">当前状态</th>
              <th class="px-6 py-4 font-semibold">报错信息 / 结果</th>
              <th class="px-6 py-4 font-semibold">创建时间</th>
              <th class="px-6 py-4 font-semibold">更新时间</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/50">
            {#each tasks as task}
              {@const Icon = getStatusIcon(task.status)}
              <tr class="group hover:bg-muted/20 transition-colors data-[status=error]:bg-red-500/5">
                <td class="px-6 py-4 font-mono text-[11px] text-muted-foreground truncate max-w-[120px]" title={task.id}>
                  {task.id}
                </td>
                <td class="px-6 py-4">
                  <div class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-secondary/80 text-secondary-foreground border">
                    {task.task_type}
                  </div>
                </td>
                <td class="px-6 py-4">
                  <div class={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider border ${getStatusColor(task.status)}`}>
                    <Icon size={12} class={task.status === 'processing' ? 'animate-spin' : ''} />
                    {task.status}
                  </div>
                </td>
                <td class="px-6 py-4">
                  {#if task.error}
                    <span class="text-xs text-red-500 break-all line-clamp-2 max-w-xs block" title={task.error}>
                      {task.error}
                    </span>
                  {:else}
                    <span class="text-xs text-muted-foreground">-</span>
                  {/if}
                </td>
                <td class="px-6 py-4 text-xs font-mono text-muted-foreground whitespace-nowrap">
                  {dayjs(task.created_at).format('YYYY-MM-DD HH:mm:ss')}
                </td>
                <td class="px-6 py-4 text-xs font-mono text-muted-foreground whitespace-nowrap">
                  {dayjs(task.updated_at).format('YYYY-MM-DD HH:mm:ss')}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
