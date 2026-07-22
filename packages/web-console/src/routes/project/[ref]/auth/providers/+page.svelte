<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { untrack } from "svelte";
  import { Loader2, Check, X, Search, Shield, KeyRound, ChevronDown, ChevronUp, Save, Trash2, Eye, EyeOff } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface ProviderConfig {
    name: string;
    key: string;
    enabled: boolean;
    category: "built_in" | "social" | "enterprise" | "china";
    client_id: string;
    client_secret: string;
    redirect_uri: string;
    auth_scheme?: string;
    expanded: boolean;
    saving: boolean;
  }

  const PROVIDERS_DEF: Omit<ProviderConfig, "enabled" | "client_id" | "client_secret" | "redirect_uri" | "auth_scheme" | "expanded" | "saving">[] = [
    { name: "Email", key: "email", category: "built_in" },
    { name: "Phone", key: "phone", category: "built_in" },
    { name: "Apple", key: "apple", category: "social" },
    { name: "Azure", key: "azure", category: "social" },
    { name: "Discord", key: "discord", category: "social" },
    { name: "Facebook", key: "facebook", category: "social" },
    { name: "Figma", key: "figma", category: "social" },
    { name: "GitHub", key: "github", category: "social" },
    { name: "GitLab", key: "gitlab", category: "social" },
    { name: "Google", key: "google", category: "social" },
    { name: "Kakao", key: "kakao", category: "social" },
    { name: "KeyCloak", key: "keycloak", category: "social" },
    { name: "LinkedIn (OIDC)", key: "linkedin_oidc", category: "social" },
    { name: "Notion", key: "notion", category: "social" },
    { name: "Twitch", key: "twitch", category: "social" },
    { name: "X / Twitter", key: "twitter", category: "social" },
    { name: "Slack (OIDC)", key: "slack_oidc", category: "social" },
    { name: "Spotify", key: "spotify", category: "social" },
    { name: "Zoom", key: "zoom", category: "social" },
    { name: "微信网页", key: "wechat", category: "china" },
    { name: "微信小程序", key: "wechat_miniprogram", category: "china" },
    { name: "微信公众号", key: "wechat_mp", category: "china" },
    { name: "QQ 登录", key: "qq", category: "china" },
    { name: "钉钉", key: "dingtalk", category: "china" },
    { name: "企业微信", key: "wecom", category: "china" },
    { name: "抖音", key: "douyin", category: "china" },
  ];

  let searchQuery = $state("");
  let showSecrets = $state<Record<string, boolean>>({});
  let saveMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const providersQuery = createQuery(() => ({
    queryKey: ["auth_providers", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/studio/providers`);
      if (!res.ok) throw new Error("Failed to load providers");
      return await res.json();
    }
  }));

  // Create local states based on the query data
  let providers = $state<ProviderConfig[]>([]);

  $effect(() => {
    if (providersQuery.data) {
      const provMap = providersQuery.data.providers || {};
      const previousProviders = untrack(() => providers);
      providers = PROVIDERS_DEF.map(def => {
        // preserve expanded state
        const existing = previousProviders.find(p => p.key === def.key);
        return {
          ...def,
          enabled: provMap[def.key]?.enabled || false,
          client_id: provMap[def.key]?.client_id || existing?.client_id || "",
          client_secret: existing?.client_secret || "",
          redirect_uri: provMap[def.key]?.redirect_uri || existing?.redirect_uri || "",
          auth_scheme: provMap[def.key]?.auth_scheme || existing?.auth_scheme || "",
          expanded: existing?.expanded || false,
          saving: false,
        };
      });
    } else if (providersQuery.isError || (untrack(() => providers.length) === 0 && !providersQuery.isPending)) {
      providers = PROVIDERS_DEF.map(def => ({
        ...def, enabled: false, client_id: "", client_secret: "", redirect_uri: "", auth_scheme: "", expanded: false, saving: false,
      }));
    }
  });

  const isLoading = $derived(providersQuery.isPending);

  const filteredProviders = $derived(
    searchQuery.trim()
      ? providers.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : providers
  );

  const enabledCount = $derived(providers.filter(p => p.enabled).length);

  const saveMutation = createMutation(() => ({
    mutationFn: async (provider: ProviderConfig) => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/providers/${provider.key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: provider.client_id,
          client_secret: provider.client_secret,
          redirect_uri: provider.redirect_uri || undefined,
          auth_scheme: provider.auth_scheme || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || res.statusText);
      }
      return { provider, ...await res.json() };
    },
    onMutate: (provider) => { provider.saving = true; },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["auth_providers", projectRef] });
      saveMsg = `✅ ${data.provider.name} 配置已保存并生效（GoTrue 已重启）`;
      setTimeout(() => saveMsg = null, 4000);
    },
    onError: (err: unknown, provider) => {
      saveMsg = `❌ 保存失败: ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => saveMsg = null, 4000);
    },
    onSettled: (data, err, provider) => { provider.saving = false; }
  }));

  async function saveProvider(provider: ProviderConfig) {
    if (!provider.client_id || !provider.client_secret) {
      saveMsg = `请填写 ${provider.name} 的 Client ID 和 Client Secret`;
      setTimeout(() => saveMsg = null, 3000);
      return;
    }
    saveMutation.mutate(provider);
  }

  const disableMutation = createMutation(() => ({
    mutationFn: async (provider: ProviderConfig) => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/providers/${provider.key}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Disable failed");
      return { provider };
    },
    onMutate: (provider) => { provider.saving = true; },
    onSuccess: (data) => {
      data.provider.client_id = "";
      data.provider.client_secret = "";
      data.provider.redirect_uri = "";
      data.provider.auth_scheme = "";
      queryClient.invalidateQueries({ queryKey: ["auth_providers", projectRef] });
      saveMsg = `${data.provider.name} 已禁用`;
      setTimeout(() => saveMsg = null, 3000);
    },
    onError: () => {
      saveMsg = `❌ 禁用失败`;
      setTimeout(() => saveMsg = null, 3000);
    },
    onSettled: (data, err, provider) => { provider.saving = false; }
  }));

  async function disableProvider(provider: ProviderConfig) {
    if (!confirm(`确定禁用 ${provider.name} 登录？`)) return;
    disableMutation.mutate(provider);
  }

  const toggleMutation = createMutation(() => ({
    mutationFn: async (provider: ProviderConfig) => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/studio/providers/${provider.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, client_id: provider.client_id }),
      });
      if (!res.ok) throw new Error("Toggle failed");
      return { provider };
    },
    onMutate: (provider) => { provider.saving = true; },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["auth_providers", projectRef] });
      saveMsg = `✅ ${data.provider.name} 已启用`;
      setTimeout(() => saveMsg = null, 3000);
    },
    onError: () => {
      saveMsg = `❌ 启用失败`;
      setTimeout(() => saveMsg = null, 3000);
    },
    onSettled: (data, err, provider) => { provider.saving = false; }
  }));

  async function toggleProvider(provider: ProviderConfig) {
    if (provider.category === "built_in") return;
    if (provider.enabled) {
      await disableProvider(provider);
    } else {
      if (!provider.client_id) {
        provider.expanded = true;
        saveMsg = `请填写 ${provider.name} 的凭据后保存`;
        setTimeout(() => saveMsg = null, 3000);
        return;
      }
      toggleMutation.mutate(provider);
    }
  }

  function getCategoryLabel(cat: string): string {
    if (cat === "built_in") return "内置";
    if (cat === "social") return "社交";
    if (cat === "china") return "国内";
    return "企业";
  }

  function getCategoryColor(cat: string): string {
    if (cat === "built_in") return "text-blue-600 bg-blue-500/10";
    if (cat === "social") return "text-violet-600 bg-violet-500/10";
    if (cat === "china") return "text-green-600 bg-green-500/10";
    return "text-amber-600 bg-amber-500/10";
  }

  function getIcon(name: string): string {
    const map: Record<string, string> = {
      "Email": "📧", "Phone": "📱", "Apple": "🍎", "Google": "🔵", "GitHub": "🐙",
      "GitLab": "🦊", "Discord": "🎮", "Facebook": "📘", "X / Twitter": "𝕏",
      "Slack (OIDC)": "💬", "Spotify": "🎵", "Twitch": "📺", "Figma": "🎨",
      "微信网页": "💚", "微信小程序": "💚", "微信公众号": "💚",
      "QQ 登录": "🐧", "钉钉": "📌", "企业微信": "🏢", "抖音": "🎵",
    };
    return map[name] || "🔑";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">认证提供者</h1>
      <p class="text-sm text-muted-foreground mt-1">配置 OAuth 登录提供者 — 点击展开填写 Client ID / Secret 后保存即生效</p>
    </div>
    <div class="flex items-center gap-3">
      <span class="px-2.5 py-1 rounded-full bg-green-500/10 text-green-600 text-xs font-bold">{enabledCount} 已启用</span>
      <span class="px-2.5 py-1 rounded-full bg-muted text-muted-foreground text-xs font-bold">{providers.length} 总计</span>
    </div>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {saveMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : saveMsg.startsWith('❌') ? 'bg-red-500/5 border-red-500/20 text-red-700' : 'bg-amber-500/5 border-amber-500/20 text-amber-700'}">
      {saveMsg}
    </div>
  {/if}

  <div class="relative max-w-sm">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input type="text" bind:value={searchQuery} placeholder="搜索提供者..."
      class="w-full pl-9 pr-3 py-2 text-xs rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在加载提供者配置...</p>
      </div>
    {:else}
      <div class="overflow-auto max-h-[70vh] divide-y divide-border/20">
        {#each filteredProviders as fp (fp.key)}
          {@const i = providers.findIndex(p => p.key === fp.key)}
          {#if i !== -1}
          <div class="group">
            <!-- Header Row (clickable to expand) -->
            <div
              role="button"
              tabindex="0"
              onclick={() => providers[i].expanded = !providers[i].expanded}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); providers[i].expanded = !providers[i].expanded; } }}
              class="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/10 transition-colors text-left cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-lg flex items-center justify-center {providers[i].enabled ? 'bg-brand/10 text-brand' : 'bg-muted/50 text-muted-foreground'}">
                  <span class="text-sm">{getIcon(providers[i].name)}</span>
                </div>
                <div>
                  <span class="font-medium text-sm">{providers[i].name}</span>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase {getCategoryColor(providers[i].category)}">{getCategoryLabel(providers[i].category)}</span>
                    {#if providers[i].enabled && providers[i].client_id}
                      <span class="text-[10px] font-mono text-muted-foreground">ID: {providers[i].client_id.substring(0, 8)}...</span>
                    {/if}
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-3">
                {#if providers[i].category !== "built_in"}
                  <button aria-label="Action button"
                    onclick={(e) => { e.stopPropagation(); toggleProvider(providers[i]); }}
                    disabled={providers[i].saving}
                    class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 {providers[i].enabled ? 'bg-green-500' : 'bg-muted-foreground/30'}"
                    role="switch"
                    aria-checked={providers[i].enabled}
                  >
                    <span class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform ring-0 transition duration-200 ease-in-out {providers[i].enabled ? 'translate-x-4' : 'translate-x-0'}"></span>
                  </button>
                {:else}
                  <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-green-500/30 bg-green-500/10">
                    <Check size={12} class="text-green-600" />
                    <span class="text-[10px] font-bold text-green-600">内置</span>
                  </div>
                {/if}
                {#if providers[i].expanded}
                  <ChevronUp size={14} class="text-muted-foreground" />
                {:else}
                  <ChevronDown size={14} class="text-muted-foreground" />
                {/if}
              </div>
            </div>

            <!-- Expanded Config Form -->
            {#if providers[i].expanded}
              <div class="px-5 pb-4 pt-1 bg-muted/5 border-t border-border/10 space-y-3">
                {#if providers[i].category === "built_in"}
                  <p class="text-xs text-muted-foreground">内置认证方式，无需额外配置。</p>
                {:else}
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <span class="text-[10px] font-semibold text-muted-foreground uppercase">Client ID (App ID)</span>
                      <input type="text" bind:value={providers[i].client_id} placeholder="填写 Client ID / App ID"
                        class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
                    </div>
                    <div>
                      <span class="text-[10px] font-semibold text-muted-foreground uppercase">Client Secret (App Secret)</span>
                      <div class="relative mt-1">
                        <input type={showSecrets[providers[i].key] ? "text" : "password"} bind:value={providers[i].client_secret} placeholder="填写 Client Secret / App Secret"
                          class="w-full px-3 py-2 pr-8 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
                        <button
                          onclick={() => showSecrets[providers[i].key] = !showSecrets[providers[i].key]}
                          class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {#if showSecrets[providers[i].key]}<EyeOff size={12} />{:else}<Eye size={12} />{/if}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <span class="text-[10px] font-semibold text-muted-foreground uppercase">Redirect URI (可选)</span>
                      <input type="text" bind:value={providers[i].redirect_uri} placeholder="https://your-domain.com/auth/v1/callback"
                        class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
                    </div>
                    <div>
                      <span class="text-[10px] font-semibold text-muted-foreground uppercase">Auth Scheme (可选)</span>
                      <input type="text" bind:value={providers[i].auth_scheme} placeholder="Basic, Bearer, etc."
                        class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
                    </div>
                  </div>
                  <div class="flex items-center justify-between pt-2">
                    <p class="text-[10px] text-muted-foreground">
                      保存后将自动更新 GoTrue 配置并重启认证服务
                    </p>
                    <div class="flex items-center gap-2">
                      {#if providers[i].enabled}
                        <button
                          onclick={() => disableProvider(providers[i])}
                          disabled={providers[i].saving}
                          class="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold rounded-lg border border-destructive text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={12} /> 禁用
                        </button>
                      {/if}
                      <button
                        onclick={() => saveProvider(providers[i])}
                        disabled={providers[i].saving}
                        class="flex items-center gap-1.5 px-4 py-1.5 text-[10px] font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
                      >
                        {#if providers[i].saving}<Loader2 size={12} class="animate-spin" />{:else}<Save size={12} />{/if}
                        保存并启用
                      </button>
                    </div>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>
