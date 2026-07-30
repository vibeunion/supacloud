<script lang="ts">
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { BarChart3, Activity, Database, Shield, HardDrive, Clock, TrendingUp, ShieldCheck } from "lucide-svelte";

  let { children } = $props();

  const projectRef = $derived(page.params.ref);

  const TABS = $derived([
    { id: "api-overview", labelKey: "Reports.api_overview", icon: Activity },
    { id: "database", labelKey: "Reports.database", icon: Database },
    { id: "query-performance", labelKey: "Reports.query_performance", icon: Clock },
    { id: "auth", labelKey: "Reports.auth", icon: Shield },
    { id: "storage", labelKey: "Reports.storage", icon: HardDrive },
    { id: "advisors", labelKey: "Reports.advisors", icon: TrendingUp },
    { id: "database-linter", labelKey: "Reports.database_linter", icon: BarChart3 },
    { id: "diagnostics", labelKey: "Reports.diagnostics", icon: ShieldCheck },
  ]);

  const currentTab = $derived(page.url.pathname.split("/reports/")[1]?.split("/")[0] || "");
</script>

<div class="h-full flex flex-col pt-4">
  {#if currentTab}
    <div class="px-6 mb-6">
      <div class="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <a href={`/project/${projectRef}/reports`} class="hover:text-foreground transition-colors">{$t("Navigation.reports")}</a>
        <span>/</span>
        <span class="text-foreground">{$t(TABS.find((tab) => tab.id === currentTab)?.labelKey || "Navigation.reports")}</span>
      </div>
      <div class="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
        {#each TABS as tab}
          <a
            href={`/project/${projectRef}/reports/${tab.id}`}
            class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-full whitespace-nowrap transition-colors {currentTab === tab.id ? 'bg-brand text-white shadow-md' : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'}"
          >
            <tab.icon size={14} />
            {$t(tab.labelKey)}
          </a>
        {/each}
      </div>
    </div>
  {/if}
  <div class="flex-1 overflow-y-auto px-6 pb-6">
    {@render children()}
  </div>
</div>

<style>
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
  .scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
