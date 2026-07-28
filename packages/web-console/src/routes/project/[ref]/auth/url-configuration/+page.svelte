<script lang="ts">
  import { apiClient } from "$lib/api";
  import { authApiResponseMessage, readAuthApiPayload } from "../../auth-api-response";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Link2, Globe, Plus, Trash2, Save } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  let newUrl = $state("");
  let saveMsg = $state<string | null>(null);
  let siteUrlError = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const urlConfigQuery = createQuery(() => ({
    queryKey: ["auth_config", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`);
      if (!res.ok) throw new Error("Failed to fetch auth config");
      const config = await res.json();
      const siteUrlValue = config.site_url || config.SITE_URL || "";
      const uris = config.uri_allow_list || config.URI_ALLOW_LIST || config.REDIRECT_URLS || "";
      const redirectUrlsValue = uris ? uris.split(",").map((u: string) => u.trim()).filter(Boolean) : [];
      return { siteUrl: siteUrlValue, redirectUrls: redirectUrlsValue };
    }
  }));

  let siteUrl = $state("");
  let redirectUrls = $state<string[]>([]);
  
  $effect(() => {
    if (urlConfigQuery.data) {
      siteUrl = urlConfigQuery.data.siteUrl;
      redirectUrls = urlConfigQuery.data.redirectUrls;
    }
  });

  const isLoading = $derived(urlConfigQuery.isPending);
  function addUrl() {
    const url = newUrl.trim();
    if (!url) return;
    if (redirectUrls.includes(url)) {
      saveMsg = `❌ ${$t("Auth.redirect_url_duplicate")}`;
      setTimeout(() => saveMsg = null, 4000);
      return;
    }
    redirectUrls = [...redirectUrls, url];
    newUrl = "";
  }

  function removeUrl(index: number) {
    redirectUrls = redirectUrls.filter((_, i) => i !== index);
  }

  const saveConfigMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_url: siteUrl,
          uri_allow_list: redirectUrls.join(","),
        })
      });
      const payload = await readAuthApiPayload(res);
      if (!res.ok) throw new Error(authApiResponseMessage(payload, res.statusText || "保存失败"));
      return payload;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth_config", projectRef] });
      siteUrlError = null;
      saveMsg = "✅ URL 配置已保存（GoTrue 已重启）";
      setTimeout(() => saveMsg = null, 4000);
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      siteUrlError = message.includes("site_url") ? message : null;
      saveMsg = `❌ 保存失败: ${message}`;
      setTimeout(() => saveMsg = null, 4000);
    }
  }));

  async function saveConfig() {
    saveMsg = null;
    siteUrlError = null;
    saveConfigMutation.mutate();
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">URL 配置</h1>
      <p class="text-sm text-muted-foreground mt-1">配置认证流程中使用的重定向 URL</p>
    </div>
    <button onclick={saveConfig} disabled={saveConfigMutation.isPending}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
      {#if saveConfigMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
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
      <input type="text" bind:value={siteUrl} placeholder="https://your-app.com" aria-invalid={siteUrlError ? "true" : undefined}
        class="w-full px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
      {#if siteUrlError}
        <p class="text-xs text-destructive">{siteUrlError}</p>
      {/if}
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
