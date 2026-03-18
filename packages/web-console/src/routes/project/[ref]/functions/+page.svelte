<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Zap, Trash2, KeyRound, Clock, Plus, X, Upload, Code2 } from "lucide-svelte";

  interface EdgeFunction {
    id: string;
    slug: string;
    name: string;
    status: string;
    created_at: string;
  }

  let functions = $state<EdgeFunction[]>([]);
  let isLoading = $state(true);
  let showCreate = $state(false);
  let newSlug = $state("");
  let newCode = $state(`import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve(async (req) => {
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

  const projectRef = $derived(page.params.ref);

  async function fetchFunctions() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/functions`);
      if (res.ok) {
        functions = await res.json();
      }
    } catch (err) {
      console.error("Failed to fetch functions:", err);
    } finally {
      isLoading = false;
    }
  }

  async function deployFunction() {
    if (!newSlug.trim()) {
      deployMsg = "❌ 请输入函数名称（slug）";
      setTimeout(() => deployMsg = null, 3000);
      return;
    }
    deploying = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/functions/${newSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: newCode }),
      });
      if (res.ok) {
        deployMsg = `✅ 函数 "${newSlug}" 部署成功`;
        showCreate = false;
        newSlug = "";
        await fetchFunctions();
      } else {
        const err = await res.json();
        deployMsg = `❌ 部署失败: ${err.error || res.statusText}`;
      }
    } catch (err: any) {
      deployMsg = `❌ 部署失败: ${err.message}`;
    } finally {
      deploying = false;
      setTimeout(() => deployMsg = null, 4000);
    }
  }

  async function deleteFunction(slug: string) {
    if (!confirm(`确定删除 Edge Function "${slug}"？此操作不可恢复。`)) return;
    try {
      await apiClient(`/v1/projects/${projectRef}/functions/${slug}`, { method: "DELETE" });
      deployMsg = `函数 "${slug}" 已删除`;
      setTimeout(() => deployMsg = null, 3000);
      await fetchFunctions();
    } catch (err) {
      console.error("Failed to delete function:", err);
    }
  }

  onMount(() => { fetchFunctions(); });
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
        <button onclick={deployFunction} disabled={deploying}
          class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
          {#if deploying}<Loader2 size={14} class="animate-spin" />{:else}<Upload size={14} />{/if}
          部署
        </button>
      </div>
    </div>
  {/if}

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
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
                <td class="px-5 py-3 text-muted-foreground text-xs font-mono tabular-nums">
                  <div class="flex items-center gap-1"><Clock size={12} />{new Date(fn.created_at).toLocaleDateString()}</div>
                </td>
                <td class="px-5 py-3 text-right">
                  <button onclick={() => deleteFunction(fn.slug)}
                    class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded text-muted-foreground transition-colors opacity-0 group-hover:opacity-100"
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
