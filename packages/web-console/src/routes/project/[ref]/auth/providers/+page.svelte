<script lang="ts">
  import { apiClient } from "$lib/api";
  import { page } from "$app/state";
  import { Loader2, Search, ChevronDown, ChevronUp, Save, Eye, EyeOff } from "lucide-svelte";
  import {
    parseProviderReceipt,
    parseStudioProviders,
    type StudioProviderSettings,
  } from "$lib/auth-settings";

  interface ProviderDefinition {
    name: string;
    key: string;
    category: "built_in" | "social" | "china";
  }

  const PROVIDERS_DEF: ProviderDefinition[] = [
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

  const projectRef = $derived(page.params.ref);

  let searchQuery = $state("");
  let providers = $state<Record<string, StudioProviderSettings>>({});
  let loading = $state(false);
  let loadError = $state(false);
  let expanded = $state<string | null>(null);
  let showSecret = $state(false);
  let draft = $state({ client_id: "", client_secret: "" });
  let saving = $state(false);
  let message = $state<{ kind: "warning" | "error"; text: string } | null>(null);

  $effect(() => {
    const ref = projectRef;
    const controller = new AbortController();
    providers = {};
    expanded = null;
    draft = { client_id: "", client_secret: "" };
    message = null;
    loadError = false;
    loading = Boolean(ref);
    if (!ref) return () => controller.abort();
    void (async () => {
      try {
        const response = await apiClient(
          `/v1/projects/${encodeURIComponent(ref)}/auth/studio/providers`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Failed to load providers");
        const parsed = parseStudioProviders(await response.json());
        if (!controller.signal.aborted) providers = parsed;
      } catch {
        if (!controller.signal.aborted) loadError = true;
      } finally {
        if (!controller.signal.aborted) loading = false;
      }
    })();
    return () => controller.abort();
  });

  const filteredProviders = $derived(
    searchQuery.trim()
      ? PROVIDERS_DEF.filter((provider) => provider.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : PROVIDERS_DEF,
  );

  function settingsFor(key: string): StudioProviderSettings {
    return providers[key] ?? { enabled: false, client_id: "", redirect_uri: "", auth_scheme: "" };
  }

  function toggle(provider: ProviderDefinition) {
    if (provider.category === "built_in") return;
    if (expanded === provider.key) {
      expanded = null;
      return;
    }
    expanded = provider.key;
    showSecret = false;
    const settings = settingsFor(provider.key);
    draft = { client_id: settings.client_id, client_secret: "" };
  }

  async function saveProvider(provider: ProviderDefinition) {
    const ref = projectRef;
    if (!ref || saving) return;
    const body = { client_id: draft.client_id, client_secret: draft.client_secret };
    saving = true;
    try {
      const response = await apiClient(
        `/v1/projects/${encodeURIComponent(ref)}/auth/providers/${encodeURIComponent(provider.key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("Failed to save provider");
      const receipt = parseProviderReceipt(payload, provider.key, true);
      if (projectRef === ref) {
        if (receipt.warning) message = { kind: "warning", text: receipt.warning };
        draft = { ...draft, client_secret: "" };
      }
    } catch {
      if (projectRef === ref) message = { kind: "error", text: "保存失败，请稍后重试" };
    } finally {
      saving = false;
    }
  }

  function categoryLabel(category: string): string {
    if (category === "built_in") return "内置";
    return category === "china" ? "国内" : "社交";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">认证提供者</h1>
    <p class="text-sm text-muted-foreground mt-1">配置 OAuth 登录提供者 — 展开填写 Client ID / Secret 后保存即生效</p>
  </div>

  {#if message}
    <div
      role={message.kind === "error" ? "alert" : "status"}
      class="rounded-lg border px-4 py-2 text-xs font-medium {message.kind === 'error' ? 'bg-red-500/5 border-red-500/20 text-red-700' : 'bg-amber-500/5 border-amber-500/20 text-amber-700'}"
    >
      {message.text}
    </div>
  {/if}

  <div class="relative max-w-sm">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="搜索提供者..."
      class="w-full pl-9 pr-3 py-2 text-xs rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
    />
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if loading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
      </div>
    {:else if loadError}
      <div role="alert" class="flex items-center justify-center py-24 px-6 text-center text-sm text-destructive">
        提供者配置暂不可用，请稍后重试。
      </div>
    {:else}
      <div class="overflow-auto max-h-[70vh] divide-y divide-border/20">
        {#each filteredProviders as provider (provider.key)}
          {@const settings = settingsFor(provider.key)}
          <div class="group">
            <div
              role="button"
              tabindex="0"
              onclick={() => toggle(provider)}
              onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(provider); } }}
              class="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/10 transition-colors text-left cursor-pointer"
            >
              <div class="flex items-center gap-3">
                <span class="font-medium text-sm">{provider.name}</span>
                <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-muted text-muted-foreground">{categoryLabel(provider.category)}</span>
              </div>
              <div class="flex items-center gap-3">
                {#if provider.category !== "built_in"}
                  <span
                    role="switch"
                    aria-checked={settings.enabled}
                    class="relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors {settings.enabled ? 'bg-green-500' : 'bg-muted-foreground/30'}"
                  >
                    <span class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition {settings.enabled ? 'translate-x-4' : 'translate-x-0'}"></span>
                  </span>
                {/if}
                {#if expanded === provider.key}
                  <ChevronUp size={14} class="text-muted-foreground" />
                {:else}
                  <ChevronDown size={14} class="text-muted-foreground" />
                {/if}
              </div>
            </div>

            {#if expanded === provider.key && provider.category !== "built_in"}
              <div class="px-5 pb-4 pt-1 bg-muted/5 border-t border-border/10 space-y-3">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <span class="text-[10px] font-semibold text-muted-foreground uppercase">Client ID (App ID)</span>
                    <input
                      type="text"
                      bind:value={draft.client_id}
                      placeholder="填写 Client ID / App ID"
                      class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"
                    />
                  </div>
                  <div>
                    <span class="text-[10px] font-semibold text-muted-foreground uppercase">Client Secret (App Secret)</span>
                    <div class="relative mt-1">
                      <input
                        type={showSecret ? "text" : "password"}
                        bind:value={draft.client_secret}
                        placeholder="填写 Client Secret / App Secret"
                        class="w-full px-3 py-2 pr-8 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                      <button
                        type="button"
                        aria-label="切换密钥可见性"
                        onclick={() => { showSecret = !showSecret; }}
                        class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {#if showSecret}<EyeOff size={12} />{:else}<Eye size={12} />{/if}
                      </button>
                    </div>
                  </div>
                </div>
                <div class="flex items-center justify-end pt-2">
                  <button
                    type="button"
                    onclick={() => saveProvider(provider)}
                    disabled={saving}
                    class="flex items-center gap-1.5 px-4 py-1.5 text-[10px] font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
                  >
                    {#if saving}<Loader2 size={12} class="animate-spin" />{:else}<Save size={12} />{/if}
                    保存并启用
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>