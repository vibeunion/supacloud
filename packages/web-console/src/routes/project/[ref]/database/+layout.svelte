<script lang="ts">
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Users, Package, Zap, Braces, Hash, FolderOpen, CalendarClock, Radio, Webhook, GitCommitVertical, Tag, ShieldCheck, HardDrive, Globe, Settings } from "lucide-svelte";

  let { children } = $props();

  const projectRef = $derived(page.params.ref);

  const TABS = $derived([
    { id: "roles", label: $t("Roles.title"), icon: Users },
    { id: "extensions", label: $t("Extensions.title"), icon: Package },
    { id: "triggers", label: $t("Triggers.title"), icon: Zap },
    { id: "functions", label: $t("DbFunctions.title"), icon: Braces },
    { id: "indexes", label: $t("Indexes.title"), icon: Hash },
    { id: "schemas", label: $t("Schemas.title"), icon: FolderOpen },
    { id: "types", label: $t("EnumTypes.title"), icon: Tag },
    { id: "column-privileges", label: $t("ColumnPrivileges.title"), icon: ShieldCheck },
    { id: "publications", label: $t("Publications.title"), icon: Radio },
    { id: "hooks", label: $t("Hooks.title"), icon: Webhook },
    { id: "migrations", label: $t("Migrations.title"), icon: GitCommitVertical },
    { id: "backups", label: $t("Backups.title"), icon: HardDrive },
    { id: "cron", label: $t("CronJobs.title"), icon: CalendarClock },
    { id: "wrappers", label: "Wrappers", icon: Globe },
    { id: "settings", label: "Settings", icon: Settings },
  ]);

  const currentTab = $derived(page.url.pathname.split("/database/")[1]?.split("/")[0] || "");
</script>

<div class="h-full flex flex-col pt-4">
  <div class="px-6 mb-6">
    <div class="flex items-center gap-2 text-sm text-muted-foreground mb-4">
      <a href={`/project/${projectRef}/database`} class="hover:text-foreground transition-colors">{$t("Navigation.database")}</a>
      {#if currentTab}
        <span>/</span>
        <span class="text-foreground capitalize">{TABS.find(t => t.id === currentTab)?.label || currentTab}</span>
      {/if}
    </div>
    <div class="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
      {#each TABS as tab}
        <a
          href={`/project/${projectRef}/database/${tab.id}`}
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
