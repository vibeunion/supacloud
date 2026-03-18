<script lang="ts">
  import { page } from "$app/state";
  import { BarChart3, Activity, Database, Shield, Zap, HardDrive, Clock, TrendingUp } from "lucide-svelte";

  let { children } = $props();

  const projectRef = $derived(page.params.ref);

  const TABS = $derived([
    { id: "api-overview", label: "API 概览", icon: Activity },
    { id: "database", label: "数据库", icon: Database },
    { id: "query-performance", label: "查询性能", icon: Clock },
    { id: "auth", label: "Auth 报表", icon: Shield },
    { id: "storage", label: "Storage 报表", icon: HardDrive },
    { id: "advisors", label: "性能顾问", icon: TrendingUp },
    { id: "database-linter", label: "数据库检查", icon: BarChart3 },
  ]);

  const currentTab = $derived(page.url.pathname.split("/reports/")[1]?.split("/")[0] || "");
</script>

<div class="h-full flex flex-col pt-4">
  <div class="px-6 mb-6">
    <div class="flex items-center gap-2 text-sm text-muted-foreground mb-4">
      <a href={`/project/${projectRef}/reports`} class="hover:text-foreground transition-colors">报表</a>
      {#if currentTab}
        <span>/</span>
        <span class="text-foreground">{TABS.find(t => t.id === currentTab)?.label || currentTab}</span>
      {/if}
    </div>
    <div class="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
      {#each TABS as tab}
        <a
          href={`/project/${projectRef}/reports/${tab.id}`}
          class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-full whitespace-nowrap transition-colors {currentTab === tab.id ? 'bg-brand text-white shadow-md' : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'}"
        >
          <tab.icon size={14} />
          {tab.label}
        </a>
      {/each}
    </div>
  </div>
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
