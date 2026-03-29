<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Plus, KeyRound, Trash2, Eye, EyeOff, AlertTriangle, Lock } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createMutation } from "@tanstack/svelte-query";
  import { useList, type BaseRecord } from "@svadmin/core";

  interface Secret extends BaseRecord {
    name: string;
    created_at: string;
    masked_value: string;
  }

  const projectRef = $derived(page.params.ref);
  const { query } = useList<Secret>({ get resource() { return `v1/projects/${projectRef}/secrets`; } });
  const secrets = $derived(Array.isArray(query.data?.data) ? query.data.data : ((query.data?.data as unknown as Record<string, unknown>)?.secrets as Secret[] || []));

  let showAdd = $state(false);
  let newKey = $state("");
  let newValue = $state("");



  const addMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ name: newKey, value: newValue }])
      });
      if (!res.ok) throw new Error("Add secret failed");
      return res.json();
    },
    onSuccess: () => {
      showAdd = false;
      newKey = "";
      newValue = "";
      query.refetch();
    },
    onError: () => {
      toast.error("无法添加 secret");
    }
  }));

  function addSecret() {
    if (!newKey.trim() || !newValue.trim()) return;
    addMutation.mutate();
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async (name: string) => {
      const res = await apiClient(`/v1/projects/${projectRef}/secrets/${name}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      return { name };
    },
    onSuccess: () => {
      query.refetch();
    },
    onError: () => {
      toast.error("无法删除 secret");
    }
  }));

  function deleteSecret(name: string) {
    if (!confirm(`确定删除 Secret "${name}"？此操作不可恢复。`)) return;
    deleteMutation.mutate(name);
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Edge Function Secrets</h1>
      <p class="text-sm text-muted-foreground mt-1">管理 Edge Functions 使用的环境变量和密钥</p>
    </div>
    <button 
      onclick={() => showAdd = !showAdd}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
    >
      <Plus size={14} />
      添加 Secret
    </button>
  </div>

  <!-- Add Secret Form -->
  {#if showAdd}
    <div class="rounded-xl border bg-card p-5 space-y-3">
      <h3 class="text-sm font-semibold">新建 Secret</h3>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <span class="text-xs text-muted-foreground">名称</span>
          <input
            type="text"
            bind:value={newKey}
            placeholder="例如: OPENAI_API_KEY"
            class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <div>
          <span class="text-xs text-muted-foreground">值</span>
          <input
            type="password"
            bind:value={newValue}
            placeholder="sk-..."
            class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <button onclick={() => showAdd = false} class="px-4 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">取消</button>
        <button onclick={addSecret} disabled={addMutation.isPending} class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
          {#if addMutation.isPending}<Loader2 size={12} class="animate-spin mr-1 inline" />{/if}保存
        </button>
      </div>
    </div>
  {/if}

  <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
    <p class="text-xs text-amber-700">Secrets 以加密形式存储，只有 Edge Functions 运行时可以读取。添加后无法查看原始值。</p>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if query.isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在加载 Secrets...</p>
      </div>
    {:else if secrets.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Lock size={40} class="opacity-20" />
        <p class="text-sm">暂无 Secrets</p>
        <p class="text-xs">点击上方按钮添加第一个 Secret</p>
      </div>
    {:else}
      <div class="overflow-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-muted/30 border-b">
            <tr>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">名称</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">值 (已掩码)</th>
              <th class="px-5 py-3 font-semibold text-muted-foreground text-xs">创建时间</th>
              <th class="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/30">
            {#each secrets as secret}
              <tr class="hover:bg-muted/5 transition-colors group">
                <td class="px-5 py-3">
                  <div class="flex items-center gap-2">
                    <KeyRound size={14} class="text-brand" />
                    <span class="font-mono font-semibold text-xs">{secret.name}</span>
                  </div>
                </td>
                <td class="px-5 py-3 text-muted-foreground font-mono text-xs">
                  {secret.masked_value || "••••••••"}
                </td>
                <td class="px-5 py-3 text-muted-foreground text-xs tabular-nums">
                  {new Date(secret.created_at).toLocaleDateString()}
                </td>
                <td class="px-5 py-3 text-right">
                  <button
                    onclick={() => deleteSecret(secret.name)}
                    disabled={deleteMutation.isPending}
                    class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded text-muted-foreground transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                    title="删除"
                  >
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
