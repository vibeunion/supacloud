<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";

  const projectRef = $derived(page.params.ref);

  onMount(() => {
    if (projectRef) {
      goto(resolve("/project/[ref]/settings", { ref: projectRef }), { replaceState: true });
    }
  });
</script>
