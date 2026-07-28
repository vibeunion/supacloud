<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { Loader2, Pause, Play, Plus, RefreshCw, Trash2, Workflow } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  type Pipeline = {
    id: string;
    name: string;
    publication_name: string;
    destination: { project_id: string; dataset_id: string };
    desired_state: "running" | "stopped";
    runtime_state: string;
  };

  const projectRef = $derived(page.params.ref);
  let items = $state<Pipeline[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let showCreate = $state(false);
  let name = $state("");
  let publication = $state("");
  let gcpProject = $state("");
  let dataset = $state("");
  let serviceAccount = $state("");

  async function request(path = "", init?: RequestInit) {
    const response = await apiClient(`/v1/projects/${projectRef}/pipelines${path}`, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "Pipeline 请求失败");
    return body;
  }

  async function load() {
    loading = true;
    try {
      const body = await request();
      items = body.items || [];
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法加载 Pipelines");
    } finally {
      loading = false;
    }
  }

  async function createPipeline() {
    saving = true;
    try {
      await request("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          publication_name: publication,
          destination: {
            type: "bigquery",
            project_id: gcpProject,
            dataset_id: dataset,
            service_account_key: serviceAccount,
          },
          batch_wait_ms: 5000,
          sync_workers: 4,
          slot_recovery: "error",
        }),
      });
      showCreate = false;
      name = publication = gcpProject = dataset = serviceAccount = "";
      await load();
      toast.success("Pipeline 已创建；确认配置后手动启动");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建失败");
    } finally {
      saving = false;
    }
  }

  async function action(item: Pipeline, operation: "start" | "stop" | "restart") {
    saving = true;
    try {
      await request(`/${item.id}/${operation}`, { method: "POST" });
      await load();
      toast.success(`Pipeline 已${operation === "start" ? "启动" : operation === "stop" ? "停止" : "重启"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      saving = false;
    }
  }

  async function removePipeline(item: Pipeline) {
    if (!confirm(`删除 Pipeline “${item.name}”？复制到 BigQuery 的已有数据不会被删除。`)) return;
    saving = true;
    try {
      await request(`/${item.id}`, { method: "DELETE" });
      await load();
      toast.success("Pipeline 已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<svelte:head><title>Pipelines · SupaCloud</title></svelte:head>

<div class="space-y-5 pb-10">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div><div class="flex items-center gap-2"><Workflow size={22} class="text-brand" /><h1 class="text-2xl font-bold">Pipelines</h1></div><p class="mt-1 text-sm text-muted-foreground">基于官方 Supabase ETL，从 PostgreSQL Publication 初始复制并持续同步 CDC 到 BigQuery。</p></div>
    <button onclick={() => showCreate = !showCreate} class="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white"><Plus size={15} />新建 Pipeline</button>
  </div>

  <div class="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-700">当前跟随 Supabase Public Alpha，仅开放 BigQuery。源表必须有主键；服务账号密钥会加密存储，运行时配置文件权限为 0600。</div>

  {#if showCreate}
    <section class="space-y-4 rounded-xl border bg-card p-5">
      <h2 class="font-semibold">BigQuery 目标</h2>
      <div class="grid gap-3 md:grid-cols-2">
        <label class="space-y-1 text-xs"><span>名称</span><input bind:value={name} class="h-9 w-full rounded-md border bg-background px-3" placeholder="production-warehouse" /></label>
        <label class="space-y-1 text-xs"><span>Publication</span><input bind:value={publication} class="h-9 w-full rounded-md border bg-background px-3 font-mono" placeholder="analytics_publication" /></label>
        <label class="space-y-1 text-xs"><span>GCP Project ID</span><input bind:value={gcpProject} class="h-9 w-full rounded-md border bg-background px-3 font-mono" /></label>
        <label class="space-y-1 text-xs"><span>BigQuery Dataset ID</span><input bind:value={dataset} class="h-9 w-full rounded-md border bg-background px-3 font-mono" /></label>
      </div>
      <label class="block space-y-1 text-xs"><span>Service Account JSON</span><textarea bind:value={serviceAccount} rows="8" spellcheck="false" class="w-full rounded-md border bg-background p-3 font-mono text-xs" placeholder="粘贴 Google service account JSON"></textarea></label>
      <div class="flex justify-end gap-2"><button onclick={() => showCreate = false} class="h-9 rounded-md border px-4 text-sm">取消</button><button onclick={createPipeline} disabled={saving || !name || !publication || !gcpProject || !dataset || !serviceAccount} class="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white disabled:opacity-50">{#if saving}<Loader2 size={15} class="animate-spin" />{/if}创建</button></div>
    </section>
  {/if}

  <section class="overflow-hidden rounded-xl border bg-card">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 size={16} class="animate-spin" />加载中</div>
    {:else if items.length === 0}
      <div class="py-16 text-center"><Workflow size={36} class="mx-auto mb-3 opacity-20" /><p class="text-sm text-muted-foreground">暂无 Pipelines</p></div>
    {:else}
      <div class="divide-y">
        {#each items as item (item.id)}
          <article class="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div><div class="flex items-center gap-2"><span class="font-semibold">{item.name}</span><span class={`rounded px-2 py-0.5 text-[10px] font-bold ${item.desired_state === "running" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{item.desired_state}</span></div><div class="mt-1 text-xs text-muted-foreground"><code>{item.publication_name}</code> → <code>{item.destination.project_id}.{item.destination.dataset_id}</code></div></div>
            <div class="flex items-center gap-1">
              {#if item.desired_state === "running"}<button title="停止" onclick={() => action(item, "stop")} disabled={saving} class="rounded-md border p-2"><Pause size={14} /></button>{:else}<button title="启动" onclick={() => action(item, "start")} disabled={saving} class="rounded-md border p-2"><Play size={14} /></button>{/if}
              <button title="重启" onclick={() => action(item, "restart")} disabled={saving} class="rounded-md border p-2"><RefreshCw size={14} /></button>
              <button title="删除" onclick={() => removePipeline(item)} disabled={saving} class="rounded-md border p-2 text-destructive"><Trash2 size={14} /></button>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</div>
