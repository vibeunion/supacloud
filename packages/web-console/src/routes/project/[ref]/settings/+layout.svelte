<script lang="ts">
  import { page } from "$app/state";

  const projectRef = $derived(page.params.ref);
  const currentPath = $derived(page.url.pathname);

  const SETTINGS_TABS = [
    { id: "", label: "General" },
    { id: "api", label: "API" },
    { id: "services", label: "服务控制" },
    { id: "webhooks", label: "Webhooks" },
    { id: "infrastructure", label: "基础设施" },
    { id: "scaling", label: "扩展/副本" },
    { id: "custom-domains", label: "域名" },
    { id: "network", label: "网络" },
    { id: "pooling", label: "连接池" },
    { id: "jwt", label: "JWT" },
    { id: "log-drains", label: "日志转发" },
    { id: "integrations", label: "集成" },
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
    <h1 class="text-2xl font-bold">项目设置</h1>
    <div class="mt-4 flex items-center gap-6 border-b border-border/50 px-1 overflow-x-auto">
      {#each SETTINGS_TABS as tab}
        <a
          href={`/project/${projectRef}/settings${tab.id ? '/' + tab.id : ''}`}
          class={`pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${isActive(tab.id) ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          {tab.label}
        </a>
      {/each}
    </div>
  </div>

  <div class="flex-1 min-h-0 overflow-auto">
    {@render children()}
  </div>
</div>
