<script lang="ts">
  import { cn } from "$lib/utils";
  import {
    Box,
    Database,
    Gauge,
    HardDrive,
    Home,
    LineChart,
    MemoryStick,
    Network,
    Settings2,
    ShieldCheck,
    SunMoon,
    Terminal,
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

  const infrastructureItems = [
    { titleKey: "Platform.extensions_market", icon: Box, href: "/platform/extensions" },
    { titleKey: "Platform.backups_pitr", icon: Database, href: "/platform/backups" },
    { titleKey: "Platform.connection_pool", icon: Network, href: "/platform/pooling" },
    { titleKey: "Platform.storage_management", icon: HardDrive, href: "/platform/storage" },
  ];

  const runtimeItems = [
    { titleKey: "Platform.monitoring", icon: LineChart, href: "/platform/monitoring" },
    { titleKey: "Platform.engine_tuning", icon: Gauge, href: "/platform/tuning" },
    { titleKey: "Platform.cache_runtime", icon: MemoryStick, href: "/platform/cache" },
  ];

  const operationsItems = [
    { titleKey: "Platform.operations_console", icon: Terminal, href: "/platform/operations" },
    { titleKey: "Platform.diagnostics", icon: ShieldCheck, href: "/platform/diagnostics" },
    { titleKey: "Platform.settings", icon: Settings2, href: "/platform/settings" },
  ];

  function isActive(href: string) {
    return $page.url.pathname === href || $page.url.pathname.startsWith(`${href}/`);
  }
</script>

<aside class={cn("flex h-screen w-64 shrink-0 flex-col border-r bg-card text-foreground", className)}>
  <div class="flex h-16 flex-col justify-center border-b px-6">
    <span class="text-xl font-bold tracking-tight text-brand">SupaCloud</span>
    <span class="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{$t("Platform.title")}</span>
  </div>

  <nav class="flex-1 overflow-y-auto px-3 py-4">
    <span class="mb-2 block px-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{$t("Platform.infrastructure")}</span>
    <div class="space-y-0.5">
      {#each infrastructureItems as item (item.href)}
        {@const Icon = item.icon}
        <a href={item.href} class={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors", isActive(item.href) ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
          <Icon class="h-[18px] w-[18px]" />
          {$t(item.titleKey)}
        </a>
      {/each}
    </div>

    <span class="mb-2 mt-6 block px-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{$t("Platform.performance_runtime")}</span>
    <div class="space-y-0.5">
      {#each runtimeItems as item (item.href)}
        {@const Icon = item.icon}
        <a href={item.href} class={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors", isActive(item.href) ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
          <Icon class="h-[18px] w-[18px]" />
          {$t(item.titleKey)}
        </a>
      {/each}
    </div>

    <span class="mb-2 mt-6 block px-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{$t("Platform.operations")}</span>
    <div class="space-y-0.5">
      {#each operationsItems as item (item.href)}
        {@const Icon = item.icon}
        <a href={item.href} class={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors", isActive(item.href) ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
          <Icon class="h-[18px] w-[18px]" />
          {$t(item.titleKey)}
        </a>
      {/each}
    </div>

  </nav>

  <div class="space-y-2 border-t p-3">
    <div class="grid grid-cols-[1fr_36px_36px] gap-1.5">
      <a href="/" class="flex min-w-0 items-center gap-2 rounded-md bg-brand/5 px-2.5 py-2 text-xs font-semibold text-brand transition-colors hover:bg-brand/10" title={$t("Sidebar.back_to_projects") || "Back to projects"} aria-label={$t("Sidebar.back_to_projects") || "Back to projects"}>
        <Home size={16} class="shrink-0" />
        <span class="truncate">{$t("Sidebar.back_to_projects") || "Back"}</span>
      </a>
      <button type="button" onclick={toggleMode} class="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title={themeToggleLabel} aria-label={themeToggleLabel}>
        <SunMoon size={16} />
      </button>
      <button type="button" onclick={toggleLanguage} class="flex h-9 w-9 items-center justify-center rounded-md text-xs font-bold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title={isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")} aria-label={isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}>
        {isZhLocale($locale) ? "EN" : "中"}
      </button>
    </div>

    <div class="flex w-full items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-2">
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-brand to-emerald-400 text-[11px] font-bold text-white">SC</span>
      <span class="flex min-w-0 flex-col text-left">
        <span class="truncate text-xs font-semibold text-foreground">{$t("Sidebar.platform_admin")}</span>
        <span class="truncate text-[10px] leading-tight text-muted-foreground">admin@supacloud.local</span>
      </span>
    </div>
  </div>
</aside>
