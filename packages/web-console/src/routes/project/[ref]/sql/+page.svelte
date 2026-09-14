<script lang="ts">
  import { page } from "$app/state";
  import SqlEditor from "./SqlEditor.svelte";

  const projectRef = $derived(page.params.ref);
</script>

{#if projectRef}
  {#key projectRef}
    <SqlEditor {projectRef} />
  {/key}
{/if}
