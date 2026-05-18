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
    { title: $t("Navigation.table_editor"), icon: Table, href: `/project/${currentProject.ref}/tables` },
    { title: $t("Navigation.sql_editor"), icon: Code2, href: `/project/${currentProject.ref}/sql` },
    { title: $t("Navigation.auth"), icon: Users, href: `/project/${currentProject.ref}/auth` },
    { title: $t("Navigation.storage"), icon: Box, href: `/project/${currentProject.ref}/storage` },
    { title: $t("Navigation.edge_functions"), icon: Zap, href: `/project/${currentProject.ref}/functions` },
    { title: $t("Hosting.title"), icon: Globe, href: `/project/${currentProject.ref}/hosting` },
    { title: $t("Realtime.title"), icon: Radio, href: `/project/${currentProject.ref}/realtime` },
    { title: $t("Navigation.database"), icon: Database, href: `/project/${currentProject.ref}/database` },
    { title: $t("Navigation.api_docs"), icon: Files, href: `/project/${currentProject.ref}/api` },
    { title: $t("Navigation.query_performance"), icon: LineChart, href: `/project/${currentProject.ref}/reports/query-performance` },
    { title: $t("Navigation.database_linter"), icon: ShieldCheck, href: `/project/${currentProject.ref}/reports/database-linter` },
    { title: $t("Sidebar.database_advisor"), icon: ShieldCheck, href: `/project/${currentProject.ref}/reports/advisors` },
    { title: $t("Navigation.reports"), icon: Glasses, href: `/project/${currentProject.ref}/reports/api-overview` },
    { title: $t("Navigation.logs"), icon: ScrollText, href: `/project/${currentProject.ref}/logs` },
    { title: $t("Navigation.tasks"), icon: Activity, href: `/project/${currentProject.ref}/tasks` },
    { title: $t("Navigation.settings"), icon: Settings, href: `/project/${currentProject.ref}/settings` },
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
        {item.title}
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

  <div class="p-4 border-t border-border/50 space-y-2 relative overflow-hidden">
    <!-- Subtle glow background at bottom -->
    <div class="absolute -bottom-10 -left-10 w-32 h-32 bg-brand/5 rounded-full blur-3xl pointer-events-none"></div>

    <a
      href="/platform"
      class="group flex w-full items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl text-brand bg-brand/5 hover:bg-brand/10 transition-all duration-300 hover:shadow-sm"
    >
      <Shield fill="currentColor" strokeWidth={1.5} class="w-4 h-4 group-hover:scale-110 transition-transform" />
      <span>{$t("Sidebar.platform_admin")}</span>
    </a>
    <button
      onclick={(e) => { e.preventDefault(); toggleMode(); }}
      class="flex w-full items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all duration-300"
    >
      <SunMoon class="w-4 h-4" />
      <span>{themeToggleLabel}</span>
    </button>
    <button
      onclick={(e) => { e.preventDefault(); toggleLanguage(); }}
      class="flex w-full items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all duration-300"
    >
      <Languages class="w-4 h-4" />
      <span>{isZhLocale($locale) ? "English" : ($t("Common.chinese") || "中文")}</span>
    </button>

    <div class="flex items-center gap-3 px-3 py-3 mt-1 bg-secondary/30 rounded-xl border border-border/30">
      <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-brand to-emerald-400 flex items-center justify-center text-white font-bold text-xs shadow-inner">
        SC
      </div>
      <div class="flex flex-col flex-1 min-w-0">
        <span class="text-sm font-semibold truncate text-foreground">Admin User</span>
        <span class="text-[10px] text-muted-foreground truncate opacity-80">admin@supacloud.local</span>
      </div>
    </div>
  </div>
</aside>
