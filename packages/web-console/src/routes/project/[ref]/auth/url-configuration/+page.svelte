<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, Link2, Globe, Plus, Trash2, Save } from "lucide-svelte";

  let redirectUrls = $state<string[]>([]);
  let siteUrl = $state("");
  let newUrl = $state("");
  let isLoading = $state(true);
  let saving = $state(false);
  let saveMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);

  async function fetchUrlConfig() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`);
      if (res.ok) {
        const config = await res.json();
        siteUrl = config.SITE_URL || config.site_url || "";
        const uris = config.URI_ALLOW_LIST || config.REDIRECT_URLS || "";
        redirectUrls = uris ? uris.split(",").map((u: string) => u.trim()).filter(Boolean) : [];
      }
    } catch { /* keep defaults */ }
    finally { isLoading = false; }
  }

  function addUrl() {
    const url = newUrl.trim();
    if (url && !redirectUrls.includes(url)) {
      redirectUrls = [...redirectUrls, url];
      newUrl = "";
    }
  }

  function removeUrl(index: number) {
    redirectUrls = redirectUrls.filter((_, i) => i !== index);
  }

  async function saveConfig() {
    saving = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          SITE_URL: siteUrl,
          URI_ALLOW_LIST: redirectUrls.join(","),
        })
      });
      if (res.ok) {
        saveMsg = "✅ URL 配置已保存（GoTrue 已重启）";
      } else {
        const err = await res.json();
        saveMsg = `❌ 保存失败: ${err.error || res.statusText}`;
      }
    } catch (err: unknown) {
      saveMsg = `❌ 保存失败: ${(err instanceof Error ? err.message : String(err))}`;
    } finally {
      saving = false;
      setTimeout(() => saveMsg = null, 4000);
    }
  }

  onMount(() => { fetchUrlConfig(); });
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">URL 配置</h1>
      <p class="text-sm text-muted-foreground mt-1">配置认证流程中使用的重定向 URL</p>
    </div>
    <button onclick={saveConfig} disabled={saving}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
      {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
      保存
    </button>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {saveMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">
      {saveMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="rounded-xl border bg-card p-6 flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- Site URL -->
    <div class="rounded-xl border bg-card p-5 space-y-3">
      <div class="flex items-center gap-2">
        <Globe size={16} class="text-brand" />
        <h2 class="font-semibold text-sm">站点 URL (SITE_URL)</h2>
      </div>
      <p class="text-xs text-muted-foreground">你的应用的默认 URL。用于认证邮件中的链接。</p>
      <input type="text" bind:value={siteUrl} placeholder="https://your-app.com"
        class="w-full px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
    </div>

    <!-- Redirect URLs -->
    <div class="rounded-xl border bg-card p-5 space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Link2 size={16} class="text-brand" />
          <h2 class="font-semibold text-sm">重定向 URL</h2>
        </div>
        <span class="px-2 py-0.5 rounded-full bg-brand/10 text-brand text-xs font-bold">{redirectUrls.length}</span>
      </div>
      <p class="text-xs text-muted-foreground">允许作为认证后重定向目标的 URL 列表。支持通配符模式。</p>

      <div class="flex items-center gap-2">
        <input type="text" bind:value={newUrl} placeholder="https://example.com/**"
          onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter") addUrl(); }}
          class="flex-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
        <button onclick={addUrl}
          class="flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
          <Plus size={14} /> 添加
        </button>
      </div>

      {#if redirectUrls.length === 0}
        <div class="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2 opacity-40">
          <Link2 size={32} strokeWidth={1} />
          <p class="text-xs">尚未配置重定向 URL</p>
        </div>
      {:else}
        <div class="space-y-1">
          {#each redirectUrls as url, i}
            <div class="flex items-center justify-between p-2.5 rounded-lg bg-muted/10 border border-border/30 hover:bg-muted/20 transition-colors group">
              <div class="flex items-center gap-2">
                <Globe size={12} class="text-muted-foreground" />
                <span class="font-mono text-xs">{url}</span>
              </div>
              <button onclick={() => removeUrl(i)}
                class="p-1 hover:bg-destructive/10 hover:text-destructive rounded text-muted-foreground transition-colors opacity-0 group-hover:opacity-100">
                <Trash2 size={12} />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
