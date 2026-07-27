<script lang="ts">
  import { t } from "svelte-i18n";
  import { cn } from "$lib/utils";
  import { ChevronDown, Plus } from "lucide-svelte";
  import { goto } from "$app/navigation";
  
  let { projects = [], currentProject = null } = $props();
  let isOpen = $state(false);

  function switchProject(ref: string) {
    isOpen = false;
    goto(`/project/${ref}`);
  }
</script>

<div class="relative px-3 py-4 border-b">
  <button 
    onclick={() => isOpen = !isOpen}
    class="w-full flex items-center justify-between px-3 py-2 rounded-md hover:bg-secondary transition-colors"
  >
    <div class="flex items-center gap-3">
      <div class="w-2 h-2 rounded-full bg-brand"></div>
      <span class="text-sm font-semibold truncate">
        {currentProject?.name || $t("Project.select_project")}
      </span>
    </div>
    <ChevronDown class="w-4 h-4 text-muted-foreground" />
  </button>

  {#if isOpen}
    <div class="absolute left-3 right-3 top-full mt-1 bg-popover border rounded-md shadow-lg z-50 py-1">
      {#each projects as project}
        <button 
          class="w-full text-left px-3 py-2 text-sm hover:bg-secondary flex items-center gap-2"
          onclick={() => switchProject(project.ref)}
        >
          <div class="w-2 h-2 rounded-full bg-brand"></div>
          {project.name}
        </button>
      {/each}
      <div class="border-t my-1"></div>
      <button
        class="w-full text-left px-3 py-2 text-sm hover:bg-secondary text-brand flex items-center gap-2"
        onclick={() => {
          isOpen = false;
          goto("/projects/create");
        }}
      >
        <Plus class="w-4 h-4" />
        {$t("Project.new_project")}
      </button>
    </div>
  {/if}
</div>
