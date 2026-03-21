<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Plus, KeyRound, Trash2, Eye, EyeOff, AlertTriangle, Lock } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  interface Secret {
    name: string;
    created_at: string;
    masked_value: string;
  }

  let secrets = $state<Secret[]>([]);
  let isLoading = $state(true);
  let showAdd = $state(false);
  let newKey = $state("");
  let newValue = $state("");

  const projectRef = $derived(page.params.ref);

  async function fetchSecrets() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/secrets`);
      if (res.ok) {
        secrets = await res.json();
      }
    } catch (err: unknown) {
      toast.error("无法fetch secrets");
    } finally {
      isLoading = false;
    }
  }

  onMount(() => { fetchSecrets(); });

  async function addSecret() {
    if (!newKey.trim() || !newValue.trim()) return;
    try {
      await apiClient(`/v1/projects/${projectRef}/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ name: newKey, value: newValue }])
      });
      showAdd = false;
      newKey = "";
      newValue = "";
      await fetchSecrets();
    } catch (err: unknown) {
      toast.error("无法add secret");
    }
  }

  async function deleteSecret(name: string) {
    if (!confirm(`确定删除 Secret "${name}"？此操作不可恢复。`)) return;
    try {
      await apiClient(`/v1/projects/${projectRef}/secrets/${name}`, { method: "DELETE" });
      await fetchSecrets();
    } catch (err: unknown) {
      toast.error("无法delete secret");
    }
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
        <button onclick={addSecret} class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">保存</button>
      </div>
    </div>
  {/if}

  <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
    <p class="text-xs text-amber-700">Secrets 以加密形式存储，只有 Edge Functions 运行时可以读取。添加后无法查看原始值。</p>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
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
                    class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded text-muted-foreground transition-colors opacity-0 group-hover:opacity-100"
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
