<script lang="ts">
  import { apiClient } from "$lib/api";
  import { Loader2, ArrowLeft } from "lucide-svelte";

  let name = $state("");
  let isCreating = $state(false);
  let error = $state<string | null>(null);

  function errorMessage(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== "object") return fallback;
    const message = (payload as Record<string, unknown>).message;
    return typeof message === "string" && message.trim() ? message : fallback;
  }

  async function submitProjectCreation(projectName: string): Promise<string> {
    const response = await apiClient("/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName }),
    });
    const project: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(project, "创建项目失败"));

    const ref = (project as Record<string, unknown> | null)?.ref;
    if (typeof ref !== "string" || !ref) throw new Error("创建项目响应缺少项目标识");
    return ref;
  }

  async function createProject() {
    const projectName = name.trim();
    if (!projectName) {
      error = "请输入项目名称";
      return;
    }

    isCreating = true;
    error = null;
    try {
      const ref = await submitProjectCreation(projectName);
      window.location.assign(`/project/${encodeURIComponent(ref)}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "创建项目失败";
    } finally {
      isCreating = false;
    }
  }
</script>

<div class="mx-auto max-w-xl space-y-6">
  <div class="flex items-center gap-3">
    <a href="/projects" class="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="返回项目列表">
      <ArrowLeft size={18} />
    </a>
    <div>
      <h1 class="text-2xl font-bold">新建项目</h1>
      <p class="mt-1 text-sm text-muted-foreground">创建后会在后台初始化数据库与服务。</p>
    </div>
  </div>

  <form class="space-y-5 rounded-xl border bg-card p-6 shadow-sm" onsubmit={(event) => { event.preventDefault(); void createProject(); }}>
    <label class="block space-y-1.5">
      <span class="text-sm font-medium">项目名称</span>
      <input
        bind:value={name}
        required
        maxlength="100"
        placeholder="my-project"
        class="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
      />
    </label>

    {#if error}
      <p class="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
    {/if}

    <div class="flex justify-end gap-3">
      <a href="/projects" class="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground">取消</a>
      <button type="submit" disabled={isCreating} class="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {#if isCreating}
          <Loader2 size={16} class="animate-spin" />
          正在创建…
        {:else}
          创建项目
        {/if}
      </button>
    </div>
  </form>
</div>
