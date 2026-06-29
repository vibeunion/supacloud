<script lang="ts">
  import { t, locale } from "svelte-i18n";
  import { cn } from "$lib/utils";
  import {
    Home,
    Table,
    Database,
    Code2,
    Users,
    Box,
    Zap,
    Settings,
    LayoutDashboard,
    Files,
    Shield,
    Languages,
    LineChart,
    ShieldCheck,
    ScrollText,
    Radio,
    Globe,
    Glasses,
    Activity,
    SunMoon
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

  const navItems = $derived(currentProject?.ref ? [
    { titleKey: "Navigation.table_editor", icon: Table, href: `/project/${currentProject.ref}/tables` },
    { titleKey: "Navigation.sql_editor", icon: Code2, href: `/project/${currentProject.ref}/sql` },
    { titleKey: "Navigation.auth", icon: Users, href: `/project/${currentProject.ref}/auth` },
    { titleKey: "Navigation.storage", icon: Box, href: `/project/${currentProject.ref}/storage` },
    { titleKey: "Navigation.edge_functions", icon: Zap, href: `/project/${currentProject.ref}/functions` },
    { titleKey: "Hosting.title", icon: Globe, href: `/project/${currentProject.ref}/hosting` },
    { titleKey: "Realtime.title", icon: Radio, href: `/project/${currentProject.ref}/realtime` },
    { titleKey: "Navigation.database", icon: Database, href: `/project/${currentProject.ref}/database` },
    { titleKey: "Navigation.api_docs", icon: Files, href: `/project/${currentProject.ref}/api` },
    { titleKey: "Navigation.query_performance", icon: LineChart, href: `/project/${currentProject.ref}/reports/query-performance` },
    { titleKey: "Navigation.database_linter", icon: ShieldCheck, href: `/project/${currentProject.ref}/reports/database-linter` },
    { titleKey: "Navigation.diagnostics", icon: ShieldCheck, href: `/project/${currentProject.ref}/reports/diagnostics` },
    { titleKey: "Sidebar.database_advisor", icon: ShieldCheck, href: `/project/${currentProject.ref}/reports/advisors` },
    { titleKey: "Navigation.reports", icon: Glasses, href: `/project/${currentProject.ref}/reports/api-overview` },
    { titleKey: "Navigation.logs", icon: ScrollText, href: `/project/${currentProject.ref}/logs` },
    { titleKey: "Navigation.tasks", icon: Activity, href: `/project/${currentProject.ref}/tasks` },
    { titleKey: "Navigation.settings", icon: Settings, href: `/project/${currentProject.ref}/settings` },
  ] : []);

  function isActive(href: string) {
    return $page.url.pathname === href || $page.url.pathname.startsWith(href);
  }
</script>

<aside class={cn("flex flex-col w-64 h-screen border-r bg-card/80 backdrop-blur-2xl text-foreground", className)}>
  <div class="h-16 flex items-center gap-3 px-6 border-b border-border/50">
    <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-brand to-purple-600 flex items-center justify-center text-white font-black text-sm shadow-md shadow-brand/20">SC</div>
    <span class="text-lg font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-muted-foreground">SupaCloud</span>
  </div>

  <ProjectSwitcher {projects} {currentProject} />

  <nav class="flex-1 overflow-y-auto py-6 px-4 space-y-1.5 scrollbar-thin scrollbar-thumb-secondary">
    <a
      href={`/project/${currentProject?.ref}`}
      class={cn(
        "group flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-300",
        $page.url.pathname === `/project/${currentProject?.ref}` || $page.url.pathname === `/project/${currentProject?.ref}/`
          ? "bg-secondary/80 text-foreground shadow-sm ring-1 ring-border/50" 
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground hover:translate-x-1"
      )}
    >
      <LayoutDashboard fill="currentColor" strokeWidth={1.5} class={cn("w-4 h-4 transition-colors", $page.url.pathname === `/project/${currentProject?.ref}` || $page.url.pathname === `/project/${currentProject?.ref}/` ? "text-brand" : "group-hover:text-brand")} />
      {$t("Dashboard.title")}
    </a>
    <div class="h-3"></div>
    {#each navItems as item}
      <a
        href={item.href}
        class={cn(
          "group flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-300",
          isActive(item.href) 
            ? "bg-secondary/80 text-foreground shadow-sm ring-1 ring-border/50" 
            : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground hover:translate-x-1"
        )}
      >
        <item.icon fill="currentColor" strokeWidth={1.5} class={cn("w-4 h-4 transition-colors", isActive(item.href) ? "text-brand" : "group-hover:text-brand")} />
        {$t(item.titleKey)}
      </a>
    {/each}

    <!-- Platform Admin separator -->
    <div class="h-px bg-border/40 my-4"></div>
    <span class="px-3 text-[10px] font-bold uppercase text-muted-foreground/40 tracking-widest mb-1 block">{$t("Sidebar.platform_admin")}</span>
    <a
      href="/platform"
      class={cn(
        "group flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-300",
        $page.url.pathname.startsWith("/platform")
          ? "bg-secondary/80 text-foreground shadow-sm ring-1 ring-border/50" 
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground hover:translate-x-1"
      )}
    >
      <Settings fill="currentColor" strokeWidth={1.5} class={cn("w-4 h-4 transition-colors", $page.url.pathname.startsWith("/platform") ? "text-brand" : "group-hover:text-brand")} />
      {$t("Sidebar.infrastructure")}
    </a>
  </nav>

  <div class="p-3 border-t border-border/50 space-y-2 relative overflow-hidden">
    <!-- Subtle glow background at bottom -->
    <div class="absolute -bottom-10 -left-10 w-32 h-32 bg-brand/5 rounded-full blur-3xl pointer-events-none"></div>

    <div class="grid grid-cols-[1fr_40px_40px] gap-1.5">
      <a
        href="/platform"
        class="group flex min-w-0 items-center gap-2 rounded-lg bg-brand/5 px-2.5 py-2 text-xs font-semibold text-brand transition-colors hover:bg-brand/10"
        title={$t("Sidebar.platform_admin")}
        aria-label={$t("Sidebar.platform_admin")}
      >
        <Shield fill="currentColor" strokeWidth={1.5} class="h-4 w-4 shrink-0 transition-transform group-hover:scale-105" />
        <span class="truncate">{$t("Sidebar.platform_admin")}</span>
      </a>
      <button
        type="button"
        onclick={(e) => { e.preventDefault(); toggleMode(); }}
        class="flex h-9 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        title={themeToggleLabel}
        aria-label={themeToggleLabel}
      >
        <SunMoon class="h-4 w-4" />
      </button>
      <button
        type="button"
        onclick={(e) => { e.preventDefault(); toggleLanguage(); }}
        class="flex h-9 w-10 items-center justify-center rounded-lg text-xs font-bold text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        title={isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}
        aria-label={isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}
      >
        {isZhLocale($locale) ? "EN" : "中"}
      </button>
    </div>

    <div class="flex items-center gap-2 px-2.5 py-2 bg-secondary/30 rounded-lg border border-border/30">
      <div class="w-7 h-7 shrink-0 rounded-full bg-gradient-to-tr from-brand to-emerald-400 flex items-center justify-center text-white font-bold text-[11px] shadow-inner">
        SC
      </div>
      <div class="flex flex-col flex-1 min-w-0">
        <span class="text-xs font-semibold truncate text-foreground">Admin User</span>
        <span class="text-[10px] leading-tight text-muted-foreground truncate opacity-80">admin@supacloud.local</span>
      </div>
    </div>
  </div>
</aside>
