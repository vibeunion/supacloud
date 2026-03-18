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
    Globe
  } from "lucide-svelte";
  import { page } from '$app/stores';

  import ProjectSwitcher from "./ProjectSwitcher.svelte";

  let { className = "", projects = [], currentProject = null } = $props();

  function toggleLanguage() {
    locale.set($locale === 'zh' ? 'en' : 'zh');
  }

  const navItems = $derived([
    { title: $t("Navigation.table_editor"), icon: Table, href: `/project/${currentProject?.ref}/tables` },
    { title: $t("Navigation.sql_editor"), icon: Code2, href: `/project/${currentProject?.ref}/sql` },
    { title: $t("Navigation.auth"), icon: Users, href: `/project/${currentProject?.ref}/auth` },
    { title: $t("Navigation.storage"), icon: Box, href: `/project/${currentProject?.ref}/storage` },
    { title: $t("Navigation.edge_functions"), icon: Zap, href: `/project/${currentProject?.ref}/functions` },
    { title: "Hosting", icon: Globe, href: `/project/${currentProject?.ref}/hosting` },
    { title: "Realtime", icon: Radio, href: `/project/${currentProject?.ref}/realtime` },
    { title: $t("Navigation.database"), icon: Database, href: `/project/${currentProject?.ref}/database` },
    { title: $t("Navigation.api_docs"), icon: Files, href: `/project/${currentProject?.ref}/api` },
    { title: $t("Navigation.query_performance"), icon: LineChart, href: `/project/${currentProject?.ref}/reports/query-performance` },
    { title: $t("Navigation.database_linter"), icon: ShieldCheck, href: `/project/${currentProject?.ref}/reports/database-linter` },
    { title: "数据库顾问", icon: ShieldCheck, href: `/project/${currentProject?.ref}/reports/advisors` },
    { title: $t("Navigation.logs"), icon: ScrollText, href: `/project/${currentProject?.ref}/logs` },
    { title: $t("Navigation.settings"), icon: Settings, href: `/project/${currentProject?.ref}/settings` },
  ]);

  function isActive(href: string) {
    return $page.url.pathname === href || $page.url.pathname.startsWith(href);
  }
</script>

<aside class={cn("flex flex-col w-64 h-screen border-r bg-card text-foreground", className)}>
  <div class="h-16 flex items-center px-6 border-b">
    <span class="text-xl font-bold tracking-tight text-brand">SupaCloud</span>
  </div>

  <ProjectSwitcher {projects} {currentProject} />

  <nav class="flex-1 overflow-y-auto py-6 px-3 space-y-1">
    <a
      href={`/project/${currentProject?.ref}`}
      class={cn(
        "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors",
        $page.url.pathname === `/project/${currentProject?.ref}` || $page.url.pathname === `/project/${currentProject?.ref}/`
          ? "bg-secondary text-foreground" 
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      )}
    >
      <LayoutDashboard class="w-4 h-4" />
      {$t("Dashboard.title")}
    </a>
    <div class="h-4"></div>
    {#each navItems as item}
      <a
        href={item.href}
        class={cn(
          "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors",
          isActive(item.href) 
            ? "bg-secondary text-foreground" 
            : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
        )}
      >
        <item.icon class="w-4 h-4" />
        {item.title}
      </a>
    {/each}

    <!-- Platform Admin separator -->
    <div class="h-px bg-border/50 my-3"></div>
    <span class="px-3 text-[9px] font-bold uppercase text-muted-foreground/50 tracking-widest">平台管理</span>
    <a
      href="/platform"
      class={cn(
        "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors",
        $page.url.pathname.startsWith("/platform")
          ? "bg-secondary text-foreground" 
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      )}
    >
      <Settings class="w-4 h-4" />
      基础设施
    </a>
  </nav>

  <div class="p-4 border-t space-y-2">
    <button
      onclick={(e) => { e.preventDefault(); toggleLanguage(); }}
      class="flex w-full items-center gap-3 px-3 py-2 text-sm font-medium rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
    >
      <Languages class="w-4 h-4" />
      <span>{$locale === 'zh' ? 'English' : '简体中文'}</span>
    </button>

    <div class="flex items-center gap-3 px-3 py-2">
      <div class="w-8 h-8 rounded-full bg-brand/20 flex items-center justify-center text-brand font-bold text-xs">
        SC
      </div>
      <div class="flex flex-col">
        <span class="text-sm font-semibold truncate">Admin User</span>
        <span class="text-xs text-muted-foreground truncate">admin@supacloud.local</span>
      </div>
    </div>
  </div>
</aside>
