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
    ShieldCheck,
    MemoryStick
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
    { titleKey: "Platform.cache_runtime", icon: MemoryStick, href: "/platform/cache" },
    { titleKey: "Platform.storage_juicefs", icon: HardDrive, href: "/platform/storage" },
    { titleKey: "Platform.operations_console", icon: Terminal, href: "/platform/operations" },
    { titleKey: "Platform.diagnostics", icon: ShieldCheck, href: "/platform/diagnostics" },
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

  <div class="p-3 border-t space-y-2">
    <div class="grid grid-cols-[1fr_36px_36px_36px] gap-1.5">
      <a
        href="/"
        class="flex min-w-0 items-center gap-2 rounded-md bg-brand/5 px-2.5 py-2 text-xs font-semibold text-brand transition-colors hover:bg-brand/10"
        title={$t("Sidebar.back_to_projects") || "Back to projects"}
        aria-label={$t("Sidebar.back_to_projects") || "Back to projects"}
      >
        <Home size={16} class="shrink-0" />
        <span class="truncate">{$t("Sidebar.back_to_projects") || "Back"}</span>
      </a>
      <a
        href="/platform/settings"
        class={cn(
          "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
          isActive("/platform/settings")
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
        title={$t("Platform.settings") || "Settings"}
        aria-label={$t("Platform.settings") || "Settings"}
      >
        <Settings2 size={16} />
      </a>
      <button
        type="button"
        onclick={toggleMode}
        class="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={themeToggleLabel}
        aria-label={themeToggleLabel}
      >
        <SunMoon size={16} />
      </button>
      <button
        type="button"
        onclick={toggleLanguage}
        class="flex h-9 w-9 items-center justify-center rounded-md text-xs font-bold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}
        aria-label={isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}
      >
        {isZhLocale($locale) ? "EN" : "中"}
      </button>
    </div>

    <div class="flex w-full items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-2">
      <span class="w-7 h-7 shrink-0 rounded-full bg-gradient-to-tr from-brand to-emerald-400 flex items-center justify-center text-white font-bold text-[11px]">
        SC
      </span>
      <span class="flex flex-col min-w-0 text-left">
        <span class="text-xs font-semibold truncate text-foreground">Platform Admin</span>
        <span class="text-[10px] leading-tight text-muted-foreground truncate">admin@supacloud.local</span>
      </span>
    </div>
  </div>
</aside>
