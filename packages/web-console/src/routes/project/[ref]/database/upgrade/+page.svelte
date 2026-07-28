<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { ArrowLeft, CheckCircle2, Loader2, TriangleAlert } from "lucide-svelte";
  import { apiClient } from "$lib/api";
  import { toast } from "svelte-sonner";

  type Upgrade = {
    id?: string;
    status?: string;
    upgrade_status?: string;
    current_major?: number;
    target_major?: number;
    current_version?: string;
    target_version?: string | null;
    scope?: string;
    affects_all_projects?: boolean;
    plan?: { required_confirmation?: string; steps?: Array<{ id: string }> };
    preflight?: { ready?: boolean; blockers?: string[]; warnings?: string[]; checks?: Array<{ id: string; status: string; message: string }> };
    error_message?: string | null;
  };

  const projectRef = $derived(page.params.ref);
  let upgrade = $state.raw<Upgrade | null>(null);
  let targetMajor = $state("18");
  let confirmation = $state("");
  let loading = $state(true);
  let saving = $state(false);

  async function request(path: string, init?: RequestInit) {
    const response = await apiClient(`/v1/projects/${projectRef}${path}`, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "请求失败");
    return body;
  }

  async function load() {
    loading = true;
    try {
      upgrade = await request("/upgrade-status") as Upgrade;
      if (upgrade?.current_major) targetMajor = String(Math.min(18, Number(upgrade.current_major) + 1));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法加载升级状态");
    } finally {
      loading = false;
    }
  }

  async function startPreflight() {
    saving = true;
    try {
      upgrade = await request("/upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_version: targetMajor }),
      }) as Upgrade;
      toast.success("预检已完成；请检查集群范围和阻断项");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "预检失败");
    } finally {
      saving = false;
    }
  }

  async function approve() {
    if (!upgrade?.id) return;
    saving = true;
    try {
      upgrade = await request(`/upgrade/${upgrade.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      }) as Upgrade;
      toast.success("升级已进入后台执行；请保持维护窗口和回滚通道可用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "审批失败");
    } finally {
      saving = false;
    }
  }

  async function rollback() {
    if (!upgrade?.id) return;
    saving = true;
    try {
      upgrade = await request(`/upgrade/${upgrade.id}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: `ROLLBACK POSTGRES CLUSTER:${upgrade.id}` }),
      }) as Upgrade;
      toast.success("已请求回滚；请等待执行器报告最终状态");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "回滚失败");
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<svelte:head><title>PostgreSQL 大版本升级 · SupaCloud</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-5 pb-10">
  <a href={resolve(`/project/${projectRef}/database` as "/")} class="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft size={15} />返回数据库</a>
  <div><h1 class="text-2xl font-bold">PostgreSQL 大版本升级</h1><p class="mt-1 text-sm text-muted-foreground">这是集群级维护操作，会影响同一 PostgreSQL 集群上的所有项目。</p></div>

  <div class="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800"><TriangleAlert size={18} class="mt-0.5 shrink-0" /><div><p class="font-semibold">集群范围，不是单项目升级</p><p class="mt-1 text-xs">流程必须先通过目标版本、备份、磁盘容量、事务和部署执行器预检；未配置部署专用执行器时会失败关闭，不会执行猜测性的 pg_upgrade。</p></div></div>

  {#if loading}
    <div class="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 size={16} class="animate-spin" />加载中</div>
  {:else if upgrade}
    <section class="space-y-4 rounded-xl border bg-card p-5">
      <div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-semibold">当前工作流</h2><p class="mt-1 text-xs text-muted-foreground">状态：<span class="font-mono">{upgrade.status || upgrade.upgrade_status}</span> · 当前版本 {upgrade.current_major || upgrade.current_version || "未知"}</p></div>{#if ["upgrade_running", "validating", "manual_recovery_required"].includes(upgrade.status || "")}<button onclick={rollback} disabled={saving} class="rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive">请求回滚</button>{/if}</div>

      {#if !upgrade.id || upgrade.status === "available" || upgrade.upgrade_status === "not_started"}
        <div class="flex flex-wrap items-end gap-3"><label class="space-y-1 text-xs"><span>目标 PostgreSQL 大版本</span><input bind:value={targetMajor} type="number" min="14" max="18" class="h-9 w-32 rounded-md border bg-background px-3 font-mono" /></label><button onclick={startPreflight} disabled={saving} class="h-9 rounded-md bg-brand px-4 text-sm font-medium text-white disabled:opacity-50">运行预检</button></div>
      {:else if upgrade.status === "awaiting_approval"}
        <div class="space-y-3"><div class="rounded-md bg-muted/40 p-3 text-xs"><p class="font-semibold">预检通过，等待明确审批</p><p class="mt-1 font-mono">{upgrade.plan?.required_confirmation}</p></div><input bind:value={confirmation} class="h-9 w-full rounded-md border bg-background px-3 font-mono text-xs" placeholder="粘贴上面的完整确认字符串" /><button onclick={approve} disabled={saving || confirmation !== upgrade.plan?.required_confirmation} class="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-white disabled:opacity-50">审批并开始备份/升级</button></div>
      {/if}

      {#if upgrade.preflight?.checks}
        <div class="grid gap-2 md:grid-cols-2">{#each upgrade.preflight.checks as check (check.id)}<div class="flex gap-2 rounded-md border p-3 text-xs"><span class={check.status === "pass" ? "text-emerald-600" : check.status === "warning" ? "text-amber-600" : "text-destructive"}>{#if check.status === "pass"}<CheckCircle2 size={15} />{:else}<TriangleAlert size={15} />{/if}</span><div><span class="font-mono">{check.id}</span><p class="mt-1 text-muted-foreground">{check.message}</p></div></div>{/each}</div>
      {/if}
      {#if upgrade.error_message}<p class="rounded-md bg-destructive/10 p-3 text-xs text-destructive">{upgrade.error_message}</p>{/if}
    </section>
  {/if}
</div>
