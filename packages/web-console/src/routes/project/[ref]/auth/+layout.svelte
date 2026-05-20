<script lang="ts">
  import { page } from "$app/state";
  import { Users, Shield, KeyRound, Link2, Mail, Clock, Webhook, BadgeCheck } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);
  const currentPath = $derived(page.url.pathname);

  const AUTH_TABS = [
    { name: "用户", path: "", icon: Users },
    { name: "提供者", path: "providers", icon: KeyRound },
    { name: "OAuth Server", path: "oauth-server", icon: BadgeCheck },
    { name: "RLS 策略", path: "policies", icon: Shield },
    { name: "URL 配置", path: "url-configuration", icon: Link2 },
    { name: "邮件模板", path: "templates", icon: Mail },
    { name: "SMTP", path: "smtp", icon: Mail },
    { name: "Hooks", path: "hooks", icon: Webhook },
    { name: "会话", path: "sessions", icon: Clock },
    { name: "MFA", path: "mfa", icon: Shield },
    { name: "限频", path: "rate-limits", icon: Shield },
    { name: "安全防护", path: "protection", icon: Shield },
  ];

  function isActive(tabPath: string): boolean {
    const base = `/project/${projectRef}/auth`;
    if (tabPath === "") return currentPath === base;
    return currentPath === `${base}/${tabPath}`;
  }

  let { children } = $props();
</script>

<div class="h-full flex flex-col space-y-4">
  <!-- Auth Tab Navigation -->
  <div class="flex items-center gap-1 px-1 overflow-x-auto border-b border-border/30 pb-0">
    {#each AUTH_TABS as tab}
      <a
        href={`/project/${projectRef}/auth${tab.path ? '/' + tab.path : ''}`}
        class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap {isActive(tab.path) ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
      >
        <tab.icon size={12} />
        {tab.name}
      </a>
    {/each}
  </div>

  <!-- Sub-page content -->
  <div class="flex-1 min-h-0 overflow-auto">
    {@render children()}
  </div>
</div>
