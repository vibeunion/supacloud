<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  onMount(() => goto("/platform/extensions"));
</script>

<div class="flex items-center justify-center py-24 text-muted-foreground text-sm">
  {$t("Common.loading", { default: "Redirecting to platform admin..." })}
</div>
