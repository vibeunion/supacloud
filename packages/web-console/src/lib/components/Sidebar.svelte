<script lang="ts">
  import { t, locale } from "svelte-i18n";
  import { cn } from "$lib/utils";
  import {
    Box,
    ChartNoAxesCombined,
    ChevronDown,
    Code2,
    Database,
    Globe,
    LayoutDashboard,
    ListChecks,
    MemoryStick,
    Radio,
    ScrollText,
    Settings,
    Shield,
    SunMoon,
    Table,
    Users,
    Zap,
  } from "lucide-svelte";
  import { page } from "$app/stores";
  import { mode, toggleMode } from "mode-watcher";

  import ProjectSwitcher from "./ProjectSwitcher.svelte";

  let { className = "", projects = [], currentProject = null } = $props();

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

  const projectRef = $derived(currentProject?.ref ?? "");

  const dataItems = $derived(projectRef ? [
    { titleKey: "Navigation.table_editor", icon: Table, href: `/project/${projectRef}/tables` },
    { titleKey: "Navigation.sql_editor", icon: Code2, href: `/project/${projectRef}/sql` },
    { titleKey: "Navigation.database_objects", icon: Database, href: `/project/${projectRef}/database` },
  ] : []);

  const buildItems = $derived(projectRef ? [
    { titleKey: "Navigation.auth", icon: Users, href: `/project/${projectRef}/auth` },
    { titleKey: "Navigation.storage", icon: Box, href: `/project/${projectRef}/storage` },
    { titleKey: "Navigation.edge_functions", icon: Zap, href: `/project/${projectRef}/functions` },
    { titleKey: "Navigation.cache", icon: MemoryStick, href: `/project/${projectRef}/cache` },
    { titleKey: "Hosting.title", icon: Globe, href: `/project/${projectRef}/hosting` },
  ] : []);

  const observeItems = $derived(projectRef ? [
    { titleKey: "Navigation.reports", icon: ChartNoAxesCombined, href: `/project/${projectRef}/reports` },
    { titleKey: "Navigation.realtime_inspector", icon: Radio, href: `/project/${projectRef}/realtime` },
    { titleKey: "Navigation.logs", icon: ScrollText, href: `/project/${projectRef}/logs` },
    { titleKey: "Navigation.tasks", icon: ListChecks, href: `/project/${projectRef}/tasks` },
  ] : []);

  function isActive(href: string) {
    return $page.url.pathname === href || $page.url.pathname.startsWith(`${href}/`);
  }

  function isProjectHome() {
    return $page.url.pathname === `/project/${projectRef}` || $page.url.pathname === `/project/${projectRef}/`;
  }

  function hasActive(items: Array<{ href: string }>) {
    return items.some((item) => isActive(item.href));
  }
</script>

<aside class={cn("flex h-screen w-64 shrink-0 flex-col border-r bg-card/80 text-foreground backdrop-blur-2xl", className)}>
  <div class="flex h-16 items-center gap-3 border-b border-border/50 px-6">
    <div class="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-purple-600 text-sm font-black text-white shadow-md shadow-brand/20">SC</div>
    <span class="bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-lg font-bold tracking-tight text-transparent">SupaCloud</span>
  </div>

  <ProjectSwitcher {projects} {currentProject} />

  <nav class="scrollbar-thin scrollbar-thumb-secondary flex-1 overflow-y-auto px-3 py-4">
    <a
      href={`/project/${projectRef}`}
      class={cn(
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
        isProjectHome() ? "bg-secondary/80 text-foreground shadow-sm ring-1 ring-border/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      )}
    >
      <LayoutDashboard fill="currentColor" strokeWidth={1.5} class={cn("h-4 w-4", isProjectHome() ? "text-brand" : "group-hover:text-brand")} />
      {$t("Dashboard.title")}
    </a>

    <div class="my-5 h-px bg-border/40"></div>

    <span class="mb-2 block px-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{$t("Sidebar.build")}</span>
    <details open={hasActive(dataItems)} class="group/details">
      <summary class={cn(
        "flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors [&::-webkit-details-marker]:hidden",
        hasActive(dataItems) ? "bg-secondary/60 text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      )}>
        <Database class="h-4 w-4 text-brand" strokeWidth={1.7} />
        <span class="flex-1">{$t("Navigation.database")}</span>
        <ChevronDown class="h-4 w-4 transition-transform group-open/details:rotate-180" />
      </summary>
      <div class="ml-4 mt-1 space-y-0.5 border-l border-border/60 pl-3">
        {#each dataItems as item (item.href)}
          {@const Icon = item.icon}
          <a href={item.href} class={cn("group flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors", isActive(item.href) ? "bg-brand/10 text-brand" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground")}>
            <Icon class="h-3.5 w-3.5" strokeWidth={1.7} />
            {$t(item.titleKey)}
          </a>
        {/each}
      </div>
    </details>

    <div class="mt-4 space-y-0.5">
      {#each buildItems as item (item.href)}
        {@const Icon = item.icon}
        <a href={item.href} class={cn("group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors", isActive(item.href) ? "bg-secondary/80 text-foreground shadow-sm ring-1 ring-border/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground")}>
          <Icon class={cn("h-4 w-4", isActive(item.href) ? "text-brand" : "group-hover:text-brand")} strokeWidth={1.5} />
          {$t(item.titleKey)}
        </a>
      {/each}
    </div>

    <span class="mb-2 mt-6 block px-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{$t("Sidebar.observe")}</span>
    <div class="space-y-0.5">
      {#each observeItems as item (item.href)}
        {@const Icon = item.icon}
        <a href={item.href} class={cn("group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors", isActive(item.href) ? "bg-secondary/80 text-foreground shadow-sm ring-1 ring-border/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground")}>
          <Icon class={cn("h-4 w-4", isActive(item.href) ? "text-brand" : "group-hover:text-brand")} strokeWidth={1.5} />
          {$t(item.titleKey)}
        </a>
      {/each}
    </div>

    <span class="mb-2 mt-6 block px-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{$t("Sidebar.configure")}</span>
    <a href={`/project/${projectRef}/settings`} class={cn("group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors", isActive(`/project/${projectRef}/settings`) ? "bg-secondary/80 text-foreground shadow-sm ring-1 ring-border/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground")}>
      <Settings class={cn("h-4 w-4", isActive(`/project/${projectRef}/settings`) ? "text-brand" : "group-hover:text-brand")} strokeWidth={1.5} />
      {$t("Navigation.settings")}
    </a>
  </nav>

  <div class="relative space-y-2 overflow-hidden border-t border-border/50 p-3">
    <div class="absolute -bottom-10 -left-10 h-32 w-32 rounded-full bg-brand/5 blur-3xl"></div>
    <div class="grid grid-cols-[1fr_40px_40px] gap-1.5">
      <a href="/platform" class="group flex min-w-0 items-center gap-2 rounded-lg bg-secondary/40 px-2.5 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground" title={$t("Sidebar.platform_admin")}>
        <Shield class="h-4 w-4 shrink-0" strokeWidth={1.5} />
        <span class="truncate">{$t("Sidebar.platform_admin")}</span>
      </a>
      <button type="button" onclick={(e) => { e.preventDefault(); toggleMode(); }} class="flex h-9 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground" title={themeToggleLabel} aria-label={themeToggleLabel}>
        <SunMoon class="h-4 w-4" />
      </button>
      <button type="button" onclick={(e) => { e.preventDefault(); toggleLanguage(); }} class="flex h-9 w-10 items-center justify-center rounded-lg text-xs font-bold text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground" title={isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")} aria-label={isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}>
        {isZhLocale($locale) ? "EN" : "中"}
      </button>
    </div>

    <div class="flex items-center gap-2 rounded-lg border border-border/30 bg-secondary/30 px-2.5 py-2">
      <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-brand to-emerald-400 text-[11px] font-bold text-white shadow-inner">SC</div>
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-xs font-semibold text-foreground">Admin User</span>
        <span class="truncate text-[10px] leading-tight text-muted-foreground opacity-80">admin@supacloud.local</span>
      </div>
    </div>
  </div>
</aside>
