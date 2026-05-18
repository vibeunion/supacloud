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
  import { page } from "$app/stores";
  import { t, locale } from "svelte-i18n";
  import { mode, toggleMode } from "mode-watcher";

  let { className = "" } = $props();

  function isZhLocale(value: string | null | undefined) {
    return (value ?? "").toLowerCase().startsWith("zh");
  }

  function toggleLanguage() {
    locale.set(isZhLocale($locale) ? "en" : "zh-CN");
  }

  const themeToggleLabel = $derived(
    mode.current === "dark"
      ? ($t("Common.light_mode") || "Light mode")
      : ($t("Common.dark_mode") || "Dark mode")
  );

  const navItems = $derived([
    { titleKey: "Platform.extensions_market", icon: Box, href: "/platform/extensions" },
    { titleKey: "Platform.backups_pitr", icon: Database, href: "/platform/backups" },
    { titleKey: "Platform.engine_tuning", icon: Settings2, href: "/platform/tuning" },
    { titleKey: "Platform.monitoring", icon: LineChart, href: "/platform/monitoring" },
    { titleKey: "Platform.connection_pool", icon: Network, href: "/platform/pooling" },
    { titleKey: "Platform.storage_juicefs", icon: HardDrive, href: "/platform/storage" },
    { titleKey: "Platform.operations_console", icon: Terminal, href: "/platform/operations" },
    { titleKey: "Platform.settings", icon: Settings2, href: "/platform/settings" },
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
        {$t(item.titleKey)}
      </a>
    {/each}
  </nav>

  <div class="p-4 border-t space-y-2">
    <a
      href="/"
      class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-brand bg-brand/5 hover:bg-brand/10 transition-colors cursor-pointer"
    >
      <Home size={18} />
      <span>{$t("Sidebar.back_to_projects") || "Back to projects"}</span>
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
      <span>{isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}</span>
    </button>
  </div>
</aside>
