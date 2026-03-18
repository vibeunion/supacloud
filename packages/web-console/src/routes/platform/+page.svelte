<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  onMount(() => goto("/platform/extensions"));
</script>

<div class="flex items-center justify-center py-24 text-muted-foreground text-sm">
  正在跳转到平台管理...
</div>
