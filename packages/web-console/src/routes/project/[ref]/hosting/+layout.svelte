<script lang="ts">
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Globe } from "lucide-svelte";

  let { children } = $props();
  const projectRef = $derived(page.params.ref);
  const currentTab = $derived(page.url.pathname.split("/hosting/")[1]?.split("/")[0] || "");
</script>

<div class="h-full flex flex-col pt-4">
  <div class="px-6 mb-6">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-2xl font-bold">{$t("Hosting.pages_title")}</h1>
        <p class="text-sm text-muted-foreground mt-1">{$t("Hosting.pages_tagline")}</p>
      </div>
      <span class="px-2 py-1 text-[10px] font-bold rounded-full bg-brand/10 text-brand border border-brand/20">{$t("Hosting.tag")}</span>
    </div>
    <div class="flex items-center gap-2 overflow-x-auto pb-2">
      <a
        href={`/project/${projectRef}/hosting`}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-full whitespace-nowrap transition-colors {currentTab === '' ? 'bg-brand text-white shadow-md' : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'}"
      >
        <Globe size={14} />
        {$t("Hosting.site_list")}
      </a>
    </div>
  </div>
  <div class="flex-1 overflow-y-auto px-6 pb-6">
    {@render children()}
  </div>
</div>
