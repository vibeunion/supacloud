<script lang="ts">
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { BarChart3, Activity, Database, Shield, Zap, HardDrive, Clock, TrendingUp, ArrowRight } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  const REPORT_SECTIONS = [
    {
      id: "overview",
      titleKey: "Reports.api_overview",
      descKey: "Reports.api_overview_desc",
      icon: Activity,
      color: "text-blue-600 bg-blue-500/10",
      href: "api-overview",
    },
    {
      id: "database",
      titleKey: "Reports.database",
      descKey: "Reports.database_desc",
      icon: Database,
      color: "text-violet-600 bg-violet-500/10",
      href: "database",
    },
    {
      id: "query-performance",
      titleKey: "Reports.query_performance",
      descKey: "Reports.query_performance_desc",
      icon: Clock,
      color: "text-amber-600 bg-amber-500/10",
      href: "query-performance",
    },
    {
      id: "auth",
      titleKey: "Reports.auth",
      descKey: "Reports.auth_desc",
      icon: Shield,
      color: "text-green-600 bg-green-500/10",
      href: "auth",
    },
    {
      id: "storage",
      titleKey: "Reports.storage",
      descKey: "Reports.storage_desc",
      icon: HardDrive,
      color: "text-teal-600 bg-teal-500/10",
      href: "storage",
    },
    {
      id: "advisors",
      titleKey: "Reports.advisors",
      descKey: "Reports.advisors_desc",
      icon: TrendingUp,
      color: "text-pink-600 bg-pink-500/10",
      href: "advisors",
    },
    {
      id: "database-linter",
      titleKey: "Reports.database_linter",
      descKey: "Reports.database_linter_desc",
      icon: BarChart3,
      color: "text-orange-600 bg-orange-500/10",
      href: "database-linter",
    },
  ];
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">{$t("Reports.title")}</h1>
    <p class="text-sm text-muted-foreground mt-1">{$t("Reports.subtitle")}</p>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
    {#each REPORT_SECTIONS as section}
      <a href={`/project/${projectRef}/reports/${section.href}`}
        class="rounded-xl border bg-card hover:border-brand/40 hover:shadow-md transition-all p-5 group cursor-pointer block">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-10 h-10 rounded-lg {section.color} flex items-center justify-center group-hover:scale-110 transition-transform">
            <section.icon size={20} />
          </div>
        </div>
        <h3 class="font-semibold text-sm flex items-center gap-2">
          {$t(section.titleKey)}
          <ArrowRight size={14} class="opacity-0 group-hover:opacity-100 transition-opacity text-brand" />
        </h3>
        <p class="text-[10px] text-muted-foreground mt-1 leading-relaxed">{$t(section.descKey)}</p>
      </a>
    {/each}
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <BarChart3 size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">{$t("Reports.data_sources_note")} <code class="bg-blue-500/10 px-1 rounded">pg_stat_statements</code>、<code class="bg-blue-500/10 px-1 rounded">pg_stat_user_tables</code> {$t("Reports.data_sources_note_suffix")}</p>
  </div>
</div>
