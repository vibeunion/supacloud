<script lang="ts">
  import { page } from "$app/state";
  import { Package, HardDrive, Activity, SlidersHorizontal, BarChart3, Database, Wrench, Settings, ShieldCheck } from "lucide-svelte";
  import { t } from "svelte-i18n";

  let { children } = $props();

  const TABS = $derived([
    { id: "extensions", labelKey: "Platform.extensions_market", icon: Package },
    { id: "backups", labelKey: "Platform.backups_pitr", icon: HardDrive },
    { id: "tuning", labelKey: "Platform.engine_tuning", icon: SlidersHorizontal },
    { id: "monitoring", labelKey: "Platform.monitoring", icon: BarChart3 },
    { id: "pooling", labelKey: "Platform.connection_pool", icon: Activity },
    { id: "storage", labelKey: "Platform.storage_juicefs", icon: Database },
    { id: "operations", labelKey: "Platform.operations_console", icon: Wrench },
    { id: "diagnostics", labelKey: "Platform.diagnostics", icon: ShieldCheck },
    { id: "settings", labelKey: "Platform.settings", icon: Settings },
  ]);

  const currentTab = $derived(page.url.pathname.split("/platform/")[1]?.split("/")[0] || "");
</script>

<div class="h-full flex flex-col pt-4">
  <div class="px-6 mb-6">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-2xl font-bold">{$t("Platform.title")}</h1>
        <p class="text-sm text-muted-foreground mt-1">{$t("Platform.subtitle", { default: "Global control panel for Pigsty infrastructure." })}</p>
      </div>
      <span class="px-2 py-1 text-[10px] font-bold rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20">SYSTEM</span>
    </div>
    <div class="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
      {#each TABS as tab}
        {@const Icon = tab.icon}
        <a
          href={`/platform/${tab.id}`}
          class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-full whitespace-nowrap transition-colors {currentTab === tab.id ? 'bg-brand text-white shadow-md' : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'}"
        >
          <Icon size={14} />
          {$t(tab.labelKey)}
        </a>
      {/each}
    </div>
  </div>
  <div class="flex-1 overflow-y-auto px-6 pb-6">
    {@render children()}
  </div>
</div>

<style>
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
</style>
