<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Zap, Trash2, KeyRound, Clock, Plus, X, Upload, Code2 } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createMutation } from "@tanstack/svelte-query";
  import { useList, type BaseRecord } from "@svadmin/core";

  interface EdgeFunction extends BaseRecord {
    id: string;
    slug: string;
    name: string;
    status: string;
    verify_jwt: boolean;
    created_at: string;
  }

  const projectRef = $derived(page.params.ref);
  const query = useList<EdgeFunction>({ get resource() { return `v1/projects/${projectRef}/functions`; } });
  const functions = $derived(Array.isArray(query.data?.data) ? query.data.data : ((query.data?.data as unknown as Record<string, unknown>)?.functions as EdgeFunction[] || []));
  let showCreate = $state(false);
  let newSlug = $state("");
  let newCode = $state(`Deno.serve(async (req) => {
  const { name } = await req.json()
  const data = {
    message: \`Hello \${name}!\`,
  }

  return new Response(
    JSON.stringify(data),
    { headers: { "Content-Type": "application/json" } },
  )
})`);
  let deploying = $state(false);
  let deployMsg = $state<string | null>(null);

  const deployMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/functions/${newSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: newCode }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || res.statusText);
      }
      return res.json();
    },
    onSuccess: () => {
      deployMsg = `✅ 函数 "${newSlug}" 部署成功`;
      showCreate = false;
      newSlug = "";
      query.refetch();
      setTimeout(() => deployMsg = null, 4000);
    },
    onError: (err: unknown) => {
      deployMsg = `❌ 部署失败: ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => deployMsg = null, 4000);
    }
  }));

  function deployFunction() {
    if (!newSlug.trim()) {
      deployMsg = "❌ 请输入函数名称（slug）";
      setTimeout(() => deployMsg = null, 3000);
      return;
    }
    deployMsg = null;
    deployMutation.mutate();
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async (slug: string) => {
      const res = await apiClient(`/v1/projects/${projectRef}/functions/${slug}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      return { slug };
    },
    onSuccess: (data) => {
      deployMsg = `函数 "${data.slug}" 已删除`;
      setTimeout(() => deployMsg = null, 3000);
      query.refetch();
    },
    onError: () => {
      toast.error("无法删除函数");
    }
  }));

  function deleteFunction(slug: string) {
    if (!confirm(`确定删除 Edge Function "${slug}"？此操作不可恢复。`)) return;
    deleteMutation.mutate(slug);
  }

  // Toggle verify_jwt config
  async function toggleVerifyJwt(fn: EdgeFunction) {
    const newValue = !fn.verify_jwt;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/functions/${fn.slug}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verify_jwt: newValue }),
      });
      if (!res.ok) throw new Error("Failed");
      fn.verify_jwt = newValue;
      toast.success(`${fn.slug}: JWT 验证已${newValue ? '开启' : '关闭'}`);
      query.refetch();
    } catch {
      toast.error(`无法修改 ${fn.slug} 的 JWT 配置`);
    }
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">{$t("Navigation.edge_functions")}</h1>
    <div class="flex items-center gap-2">
      <a href={`/project/${projectRef}/functions/secrets`}
        class="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border hover:bg-muted/50 transition-colors">
        <KeyRound size={14} /> Secrets
      </a>
      <button onclick={() => showCreate = !showCreate}
        class="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-brand text-white hover:bg-brand/90 transition-colors">
        {#if showCreate}<X size={14} /> 取消{:else}<Plus size={14} /> 新建函数{/if}
      </button>
    </div>
  </div>

  {#if deployMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {deployMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : deployMsg.startsWith('❌') ? 'bg-red-500/5 border-red-500/20 text-red-700' : 'bg-blue-500/5 border-blue-500/20 text-blue-700'}">
      {deployMsg}
    </div>
  {/if}

  <!-- Create/Deploy Panel -->
  {#if showCreate}
    <div class="rounded-xl border border-brand/20 bg-brand/5 p-4 space-y-3">
      <div class="flex items-center gap-2">
        <Code2 size={16} class="text-brand" />
        <span class="font-semibold text-sm">创建 Edge Function</span>
      </div>
      <div>
        <span class="text-[10px] font-semibold text-muted-foreground uppercase">函数名称 (slug)</span>
        <input type="text" bind:value={newSlug} placeholder="hello-world"
          class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
      <div>
        <span class="text-[10px] font-semibold text-muted-foreground uppercase">函数代码 (TypeScript / Deno)</span>
        <textarea bind:value={newCode} rows={12}
          class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand resize-y leading-5"
          spellcheck="false"></textarea>
      </div>
      <div class="flex items-center justify-between">
        <p class="text-[10px] text-muted-foreground">函数将被部署到 <code class="text-[9px] bg-muted px-1 rounded">/functions/v1/{newSlug || "slug"}</code></p>
        <button onclick={deployFunction} disabled={deployMutation.isPending}
          class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
          {#if deployMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Upload size={14} />{/if}
          部署
        </button>
      </div>
    </div>
  {/if}

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if query.isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在查询 Edge Functions...</p>
      </div>
    {:else if functions.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <div class="w-16 h-16 rounded-full bg-brand/10 flex items-center justify-center">
          <Zap size={28} class="text-brand opacity-50" />
        </div>
        <p class="text-foreground font-medium">{$t("Functions.no_functions")}</p>
        <p class="text-xs max-w-md text-center">{$t("Functions.description")}</p>
        <button onclick={() => showCreate = true}
          class="mt-3 flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
          <Plus size={14} /> 创建第一个函数
        </button>
      </div>
    {:else}
      <div class="overflow-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-muted/30 border-b">
            <tr>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">函数名</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">状态</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">JWT 验证</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">端点</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">创建时间</th>
              <th class="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/30">
            {#each functions as fn}
              <tr class="hover:bg-muted/5 transition-colors group">
                <td class="px-5 py-3">
                  <div class="flex items-center gap-2">
                    <Zap size={14} class="text-brand" />
                    <span class="font-mono font-semibold text-xs">{fn.slug}</span>
                  </div>
                </td>
                <td class="px-5 py-3">
                  <span class="px-2 py-0.5 rounded-full text-[9px] font-bold {fn.status === 'ACTIVE' ? 'text-green-600 bg-green-500/10' : 'text-amber-600 bg-amber-500/10'}">{fn.status}</span>
                </td>
                <td class="px-5 py-3">
                  <code class="text-[10px] text-muted-foreground">/functions/v1/{fn.slug}</code>
                </td>
                <td class="px-5 py-3">
                  <button onclick={() => toggleVerifyJwt(fn)}
                    class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors {fn.verify_jwt ? 'bg-brand' : 'bg-muted-foreground/30'}"
                    title={fn.verify_jwt ? 'JWT 验证已开启（点击关闭）' : 'JWT 验证已关闭（点击开启）'}>
                    <span class="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform shadow-sm {fn.verify_jwt ? 'translate-x-[18px]' : 'translate-x-[3px]'}"></span>
                  </button>
                </td>
                <td class="px-5 py-3 text-muted-foreground text-xs font-mono tabular-nums">
                  <div class="flex items-center gap-1"><Clock size={12} />{new Date(fn.created_at).toLocaleDateString()}</div>
                </td>
                <td class="px-5 py-3 text-right">
                  <button onclick={() => deleteFunction(fn.slug)} disabled={deleteMutation.isPending}
                    class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded text-muted-foreground transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                    title="删除">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
