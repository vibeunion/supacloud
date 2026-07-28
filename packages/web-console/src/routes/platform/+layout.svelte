<script lang="ts">
  import { t } from "svelte-i18n";

  let { children } = $props();
</script>

<div class="flex h-full flex-col pt-4">
  <div class="mb-6 px-6">
    <div class="flex items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold">{$t("Platform.title")}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{$t("Platform.subtitle", { default: "Global control panel for Pigsty infrastructure." })}</p>
      </div>
      <span class="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-600">SYSTEM</span>
    </div>
  </div>
  <div class="flex-1 overflow-y-auto px-6 pb-6">
    {@render children()}
  </div>
</div>
