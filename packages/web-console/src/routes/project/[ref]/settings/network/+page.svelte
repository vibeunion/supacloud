<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, Shield, Plus, Trash2, Save, AlertTriangle, Globe } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  let allowedIps = $state<string[]>([]);
  let newIp = $state("");
  let msg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const networkQuery = createQuery(() => ({
    queryKey: ["network_restrictions", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/network-restrictions`);
      if (!res.ok) throw new Error("Failed to fetch restrictions");
      const data = await res.json();
      return (data.allowed_address_ranges || []) as string[];
    }
  }));

  $effect(() => {
    if (networkQuery.data) {
      allowedIps = [...networkQuery.data];
    }
  });

  const isLoading = $derived(networkQuery.isPending);

  function addIp() {
    const ip = newIp.trim();
    if (!ip) return;
    if (allowedIps.includes(ip)) return;
    allowedIps = [...allowedIps, ip];
    newIp = "";
  }

  function removeIp(ip: string) {
    allowedIps = allowedIps.filter(i => i !== ip);
  }

  const saveMutation = createMutation(() => ({
    mutationFn: async (ips: string[]) => {
      const res = await apiClient(`/v1/projects/${projectRef}/network-restrictions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowed_address_ranges: ips })
      });
      if (!res.ok) throw new Error("保存失败");
      return res.json();
    },
    onSuccess: () => {
      msg = "✅ 网络限制已保存，Kong 配置已更新";
      queryClient.invalidateQueries({ queryKey: ["network_restrictions", projectRef] });
      setTimeout(() => msg = null, 4000);
    },
    onError: (err: unknown) => {
      msg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => msg = null, 4000);
    }
  }));

  function saveRestrictions() {
    msg = null;
    saveMutation.mutate(allowedIps);
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">网络限制</h1>
      <p class="text-sm text-muted-foreground mt-1">通过 IP 白名单控制哪些来源可以访问你的项目 API</p>
    </div>
    <button onclick={saveRestrictions} disabled={saveMutation.isPending}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
      {#if saveMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
      保存规则
    </button>
  </div>

  {#if msg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {msg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">{msg}</div>
  {/if}

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Shield size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">网络限制通过 Kong 的 <code class="bg-blue-500/10 px-1 rounded">ip-restriction</code> 插件实现。如果列表为空，则允许所有 IP 访问。添加 IP 后，只有白名单中的 IP 才能访问 API。支持 CIDR 格式（如 <code class="bg-blue-500/10 px-1 rounded">192.168.1.0/24</code>）。</p>
  </div>

  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- Add IP -->
    <div class="rounded-xl border bg-card p-5 space-y-3">
      <h3 class="text-sm font-semibold">添加 IP 地址</h3>
      <div class="flex gap-2">
        <input type="text" bind:value={newIp} placeholder="192.168.1.0/24 或 10.0.0.1"
          onkeydown={(e) => { if (e.key === 'Enter') addIp(); }}
          class="flex-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
        <button onclick={addIp} class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors flex items-center gap-1.5">
          <Plus size={14} /> 添加
        </button>
      </div>
    </div>

    <!-- IP List -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold">允许访问的 IP 地址 ({allowedIps.length})</h3>
      </div>
      {#if allowedIps.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <Globe size={40} class="opacity-20" />
          <p class="text-sm">无限制 — 所有 IP 均可访问</p>
          <p class="text-xs">添加 IP 地址后，将仅允许白名单中的来源访问</p>
        </div>
      {:else}
        <div class="divide-y divide-border/20">
          {#each allowedIps as ip}
            <div class="flex items-center justify-between px-5 py-3 hover:bg-muted/10 transition-colors group">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
                  <Shield size={14} />
                </div>
                <span class="font-mono text-sm font-medium">{ip}</span>
              </div>
              <button onclick={() => removeIp(ip)}
                class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded-md text-muted-foreground transition-colors opacity-0 group-hover:opacity-100">
                <Trash2 size={14} />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if allowedIps.length > 0}
      <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
        <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
        <p class="text-xs text-amber-700"><b>注意</b>：保存后，只有上方列出的 IP 地址才能访问你的项目 API。请确保你当前的 IP 在白名单中，否则你将被锁定。</p>
      </div>
    {/if}
  {/if}
</div>
