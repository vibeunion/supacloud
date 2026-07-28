<script lang="ts">
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import {
    ArrowUpCircle,
    Braces,
    CalendarClock,
    ChevronDown,
    FlaskConical,
    FolderOpen,
    GitCommitVertical,
    Globe,
    HardDrive,
    Hash,
    KeyRound,
    Layers,
    Package,
    Radio,
    Settings,
    ShieldCheck,
    Tag,
    Users,
    Webhook,
    Workflow,
    Zap,
  } from "lucide-svelte";

  let { children } = $props();

  const projectRef = $derived(page.params.ref);

  type DatabaseTab = {
    id: string;
    labelKey?: string;
    labelFallback?: string;
    icon: typeof FolderOpen;
  };

  type DatabaseTabGroup = {
    labelKey: string;
    items: readonly DatabaseTab[];
  };

  const TAB_GROUPS: readonly DatabaseTabGroup[] = [
    {
      labelKey: "DatabaseNav.build",
      items: [
        { id: "schemas", labelKey: "Schemas.title", icon: FolderOpen },
        { id: "types", labelKey: "EnumTypes.title", icon: Tag },
        { id: "functions", labelKey: "DbFunctions.title", icon: Braces },
        { id: "triggers", labelKey: "Triggers.title", icon: Zap },
        { id: "materialized-views", labelFallback: "Materialized Views", icon: Layers },
      ],
    },
    {
      labelKey: "DatabaseNav.access",
      items: [
        { id: "roles", labelKey: "Roles.title", icon: Users },
        { id: "column-privileges", labelKey: "ColumnPrivileges.title", icon: ShieldCheck },
        { id: "rls-tester", labelFallback: "RLS Tester", icon: FlaskConical },
        { id: "temporary-access", labelFallback: "Temporary Access", icon: KeyRound },
      ],
    },
    {
      labelKey: "DatabaseNav.data_flow",
      items: [
        { id: "indexes", labelKey: "Indexes.title", icon: Hash },
        { id: "extensions", labelKey: "Extensions.title", icon: Package },
        { id: "publications", labelKey: "Publications.title", icon: Radio },
        { id: "hooks", labelKey: "Hooks.title", icon: Webhook },
        { id: "pipelines", labelFallback: "Pipelines", icon: Workflow },
        { id: "wrappers", labelFallback: "Wrappers", icon: Globe },
        { id: "cron", labelKey: "CronJobs.title", icon: CalendarClock },
      ],
    },
    {
      labelKey: "DatabaseNav.operations",
      items: [
        { id: "migrations", labelKey: "Migrations.title", icon: GitCommitVertical },
        { id: "backups", labelKey: "Backups.title", icon: HardDrive },
        { id: "upgrade", labelFallback: "PostgreSQL Upgrade", icon: ArrowUpCircle },
        { id: "settings", labelFallback: "Settings", icon: Settings },
      ],
    },
  ];

  const currentTab = $derived(page.url.pathname.split("/database/")[1]?.split("/")[0] || "");
  const activeTab = $derived(TAB_GROUPS.flatMap((group) => group.items).find((tab) => tab.id === currentTab));
  let menuBar = $state<HTMLDivElement>();

  function groupIsActive(items: readonly { id: string }[]) {
    return items.some((item) => item.id === currentTab);
  }

  function closeMenusOnOutsideClick(event: MouseEvent) {
    if (!(event.target instanceof Node)) return;
    for (const details of menuBar?.querySelectorAll<HTMLDetailsElement>("details[open]") ?? []) {
      if (!details.contains(event.target)) details.open = false;
    }
  }

  function handleMenuKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !(event.currentTarget instanceof HTMLElement)) return;
    const details = event.currentTarget.closest("details");
    if (!(details instanceof HTMLDetailsElement)) return;
    event.preventDefault();
    details.open = false;
    event.currentTarget.focus();
  }
</script>

<svelte:window onclick={closeMenusOnOutsideClick} />

<div class="flex h-full flex-col pt-4">
  <div class="mb-6 px-6">
    <div class="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
      <a href={`/project/${projectRef}/database`} class="transition-colors hover:text-foreground">{$t("Navigation.database")}</a>
      {#if activeTab}
        <span>/</span>
        <span class="text-foreground">{activeTab.labelKey ? $t(activeTab.labelKey) : activeTab.labelFallback}</span>
      {/if}
    </div>

    <div bind:this={menuBar} class="flex flex-wrap items-center gap-2">
      <a href={`/project/${projectRef}/database`} class="rounded-lg px-3 py-2 text-xs font-semibold transition-colors {currentTab === '' ? 'bg-brand text-white shadow-sm' : 'border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'}">
        {$t("Navigation.database_objects")}
      </a>
      {#each TAB_GROUPS as group (group.labelKey)}
        <details name="database-navigation" class="group/details relative">
          <summary onkeydown={handleMenuKeydown} class="flex cursor-pointer list-none items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors [&::-webkit-details-marker]:hidden {groupIsActive(group.items) ? 'border-brand/30 bg-brand/10 text-brand' : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'}">
            {$t(group.labelKey)}
            <ChevronDown class="h-3.5 w-3.5 transition-transform group-open/details:rotate-180" />
          </summary>
          <div class="absolute left-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl">
            {#each group.items as tab (tab.id)}
              {@const Icon = tab.icon}
              <a href={`/project/${projectRef}/database/${tab.id}`} class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors {currentTab === tab.id ? 'bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}">
                <Icon class="h-4 w-4" />
                {tab.labelKey ? $t(tab.labelKey) : tab.labelFallback}
              </a>
            {/each}
          </div>
        </details>
      {/each}
    </div>
  </div>
  <div class="flex-1 overflow-y-auto px-6 pb-6">
    {@render children()}
  </div>
</div>
