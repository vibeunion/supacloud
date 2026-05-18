<script lang="ts">
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Users, Package, Zap, Braces, Hash, FolderOpen, CalendarClock, Radio, Webhook, GitCommitVertical, Tag, ShieldCheck, HardDrive, Globe, Settings } from "lucide-svelte";

  let { children } = $props();

  const projectRef = $derived(page.params.ref);

  const TABS = $derived([
    { id: "roles", labelKey: "Roles.title", icon: Users },
    { id: "extensions", labelKey: "Extensions.title", icon: Package },
    { id: "triggers", labelKey: "Triggers.title", icon: Zap },
    { id: "functions", labelKey: "DbFunctions.title", icon: Braces },
    { id: "indexes", labelKey: "Indexes.title", icon: Hash },
    { id: "schemas", labelKey: "Schemas.title", icon: FolderOpen },
    { id: "types", labelKey: "EnumTypes.title", icon: Tag },
    { id: "column-privileges", labelKey: "ColumnPrivileges.title", icon: ShieldCheck },
    { id: "publications", labelKey: "Publications.title", icon: Radio },
    { id: "hooks", labelKey: "Hooks.title", icon: Webhook },
    { id: "migrations", labelKey: "Migrations.title", icon: GitCommitVertical },
    { id: "backups", labelKey: "Backups.title", icon: HardDrive },
    { id: "cron", labelKey: "CronJobs.title", icon: CalendarClock },
    { id: "wrappers", labelKey: null, labelFallback: "Wrappers", icon: Globe },
    { id: "settings", labelKey: null, labelFallback: "Settings", icon: Settings },
  ]);

  const currentTab = $derived(page.url.pathname.split("/database/")[1]?.split("/")[0] || "");
</script>

<div class="h-full flex flex-col pt-4">
  <div class="px-6 mb-6">
    <div class="flex items-center gap-2 text-sm text-muted-foreground mb-4">
      <a href={`/project/${projectRef}/database`} class="hover:text-foreground transition-colors">{$t("Navigation.database")}</a>
      {#if currentTab}
        <span>/</span>
        {@const activeTab = TABS.find(t => t.id === currentTab)}
        <span class="text-foreground capitalize">{activeTab?.labelKey ? $t(activeTab.labelKey) : (activeTab?.labelFallback || currentTab)}</span>
      {/if}
    </div>
    <div class="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
      {#each TABS as tab}
        <a
          href={`/project/${projectRef}/database/${tab.id}`}
          class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-full whitespace-nowrap transition-colors {currentTab === tab.id ? 'bg-brand text-white shadow-md' : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'}"
        >
          <tab.icon size={14} />
          {tab.labelKey ? $t(tab.labelKey) : tab.labelFallback}
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
