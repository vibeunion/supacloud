<script lang="ts">
  import { cn } from "$lib/utils";
  import { 
    Box, 
    Database, 
    Settings2, 
    LineChart, 
    Network, 
    HardDrive, 
    Terminal,
    Languages,
    Home,
    SunMoon
  } from "lucide-svelte";
  import { page } from '$app/stores';
  import { t, locale } from "svelte-i18n";
  import { mode, toggleMode } from "mode-watcher";

  let { className = "" } = $props();

  function toggleLanguage() {
    locale.set($locale === 'zh' ? 'en' : 'zh');
  }

  const themeToggleLabel = $derived(mode.current === 'dark' ? '切换到浅色模式' : '切换到深色模式');

  const navItems = $derived([
    { title: $t("Platform.extensions_market"), icon: Box, href: `/platform/extensions` },
    { title: $t("Platform.backups_pitr"), icon: Database, href: `/platform/backups` },
    { title: $t("Platform.engine_tuning"), icon: Settings2, href: `/platform/tuning` },
    { title: $t("Platform.monitoring"), icon: LineChart, href: `/platform/monitoring` },
    { title: $t("Platform.connection_pool"), icon: Network, href: `/platform/pooling` },
    { title: $t("Platform.storage_juicefs"), icon: HardDrive, href: `/platform/storage` },
    { title: $t("Platform.operations_console"), icon: Terminal, href: `/platform/operations` },
    { title: $t("Platform.settings") || "系统设置", icon: Settings2, href: `/platform/settings` },
  ]);

  function isActive(href: string) {
    return $page.url.pathname === href || $page.url.pathname.startsWith(href);
  }
</script>

<aside class={cn("flex flex-col w-64 h-screen border-r bg-card text-foreground", className)}>
  <div class="h-16 flex flex-col justify-center px-6 border-b">
    <span class="text-xl font-bold tracking-tight text-brand">SupaCloud</span>
    <span class="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase mt-0.5">{$t("Platform.title")}</span>
  </div>

  <nav class="flex-1 overflow-y-auto py-4 px-3 space-y-1">
    {#each navItems as item}
      {@const Icon = item.icon}
      <a
        href={item.href}
        class={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
          isActive(item.href) ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        <Icon size={18} />
        {item.title}
      </a>
    {/each}
  </nav>

  <div class="p-4 border-t space-y-2">
    <a 
      href="/"
      class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-brand bg-brand/5 hover:bg-brand/10 transition-colors cursor-pointer"
    >
      <Home size={18} />
      <span>{$t("Sidebar.back_to_projects") || "返回项目列表"}</span>
    </a>
    <button
      onclick={toggleMode}
      class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
    >
      <SunMoon size={18} />
      <span>{themeToggleLabel}</span>
    </button>
    <button 
      onclick={toggleLanguage}
      class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
    >
      <Languages size={18} />
      <span>{$locale === 'zh' ? 'English' : '中文'}</span>
    </button>
  </div>
</aside>
