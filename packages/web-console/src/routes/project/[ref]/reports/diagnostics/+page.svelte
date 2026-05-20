<script lang="ts">
  import { page } from "$app/state";
  import DiagnosticsRunPanel from "$lib/components/DiagnosticsRunPanel.svelte";

  const projectRef = $derived(page.params.ref);
</script>

<DiagnosticsRunPanel scope="project" {projectRef} />
