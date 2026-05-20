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
    SunMoon,
    ChevronDown,
    ShieldCheck
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
    { titleKey: "Platform.diagnostics", icon: ShieldCheck, href: "/platform/diagnostics" },
  ]);

  const isPlatformSettingsActive = $derived(
    $page.url.pathname === "/platform/settings" || $page.url.pathname.startsWith("/platform/settings/")
  );
  let isDisplaySettingsOpen = $state(false);

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

    {#if isDisplaySettingsOpen || isPlatformSettingsActive}
      <div class="space-y-1 rounded-md border bg-muted/20 p-2">
        <a
          href="/platform/settings"
          class={cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
            isActive("/platform/settings")
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <Settings2 size={16} />
          <span>{$t("Platform.settings") || "Settings"}</span>
        </a>
        <button
          type="button"
          onclick={toggleMode}
          class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
        >
          <SunMoon size={16} />
          <span>{themeToggleLabel}</span>
        </button>
        <button
          type="button"
          onclick={toggleLanguage}
          class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
        >
          <Languages size={16} />
          <span>{isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}</span>
        </button>
      </div>
    {/if}

    <button
      type="button"
      onclick={() => { isDisplaySettingsOpen = !isDisplaySettingsOpen; }}
      class="flex w-full items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2 hover:bg-muted/40 transition-colors cursor-pointer"
      aria-expanded={isDisplaySettingsOpen || isPlatformSettingsActive}
    >
      <span class="flex items-center gap-3 min-w-0">
        <span class="w-8 h-8 shrink-0 rounded-full bg-gradient-to-tr from-brand to-emerald-400 flex items-center justify-center text-white font-bold text-xs">
          SC
        </span>
        <span class="flex flex-col min-w-0 text-left">
          <span class="text-sm font-semibold truncate text-foreground">Platform Admin</span>
          <span class="text-[10px] text-muted-foreground truncate">admin@supacloud.local</span>
        </span>
      </span>
      <ChevronDown
        size={16}
        class={cn(
          "shrink-0 text-muted-foreground transition-transform",
          (isDisplaySettingsOpen || isPlatformSettingsActive) ? "rotate-180" : ""
        )}
      />
    </button>
  </div>
</aside>
