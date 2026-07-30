<script lang="ts">
  import { page } from "$app/state";
  import { t } from "svelte-i18n";

  const projectRef = $derived(page.params.ref);
  const currentPath = $derived(page.url.pathname);

  const SETTINGS_TABS = [
    { id: "", labelKey: "ProjectSettings.tab_general" },
    { id: "api", labelKey: "ProjectSettings.tab_api" },
    { id: "services", labelKey: "ProjectSettings.tab_services" },
    { id: "webhooks", labelKey: "ProjectSettings.tab_webhooks" },
    { id: "branches", labelKey: "ProjectSettings.tab_branches" },
    { id: "infrastructure", labelKey: "ProjectSettings.tab_infrastructure" },
    { id: "scaling", labelKey: "ProjectSettings.tab_scaling" },
    { id: "custom-domains", labelKey: "ProjectSettings.tab_custom_domains" },
    { id: "network", labelKey: "ProjectSettings.tab_network" },
    { id: "pooling", labelKey: "ProjectSettings.tab_pooling" },
    { id: "jwt", labelKey: "ProjectSettings.tab_jwt" },
    { id: "log-drains", labelKey: "ProjectSettings.tab_log_drains" },
    { id: "integrations", labelKey: "ProjectSettings.tab_integrations" },
  ];

  function isActive(tabId: string): boolean {
    const base = `/project/${projectRef}/settings`;
    if (tabId === "") return currentPath === base;
    return currentPath === `${base}/${tabId}`;
  }

  let { children } = $props();
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">{$t("ProjectSettings.title")}</h1>
    <div class="mt-4 flex items-center gap-6 border-b border-border/50 px-1 overflow-x-auto">
      {#each SETTINGS_TABS as tab}
        <a
          href={`/project/${projectRef}/settings${tab.id ? '/' + tab.id : ''}`}
          class={`pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${isActive(tab.id) ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          {$t(tab.labelKey)}
        </a>
      {/each}
    </div>
  </div>

  <div class="flex-1 min-h-0 overflow-auto">
    {@render children()}
  </div>
</div>
