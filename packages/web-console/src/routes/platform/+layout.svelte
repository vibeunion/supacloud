<script lang="ts">
  import { page } from "$app/state";
  import { Package, HardDrive, Activity, SlidersHorizontal, BarChart3, Database, Wrench } from "lucide-svelte";

  let { children } = $props();

  const TABS = [
    { id: "extensions", label: "扩展市场", icon: Package },
    { id: "backups", label: "物理备份", icon: HardDrive },
    { id: "tuning", label: "参数调优", icon: SlidersHorizontal },
    { id: "monitoring", label: "Grafana 监控", icon: BarChart3 },
    { id: "pooling", label: "连接池诊断", icon: Activity },
    { id: "storage", label: "存储管理", icon: Database },
    { id: "operations", label: "运维操作", icon: Wrench },
  ];

  const currentTab = $derived(page.url.pathname.split("/platform/")[1]?.split("/")[0] || "");
</script>

<div class="h-full flex flex-col pt-4">
  <div class="px-6 mb-6">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-2xl font-bold">平台管理</h1>
        <p class="text-sm text-muted-foreground mt-1">Pigsty 基础设施级的全局管控面板</p>
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
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
</style>
