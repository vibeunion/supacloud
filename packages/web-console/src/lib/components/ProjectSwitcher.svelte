<script lang="ts">
  import { t } from "svelte-i18n";
  import { goto } from "$app/navigation";
  import { Button, TenantSwitcher } from "@svadmin/ui";
  import { Plus } from "lucide-svelte";

  interface ProjectSummary {
    ref: string;
    name?: string;
  }

  let {
    projects = [],
    currentProject = null,
  }: {
    projects?: ProjectSummary[];
    currentProject?: ProjectSummary | null;
  } = $props();

  const tenants = $derived(projects.map((project) => ({
    id: project.ref,
    name: project.name ?? project.ref,
  })));

  function switchProject(ref: string) {
    goto(`/project/${ref}`);
  }
</script>

<div class="space-y-1 border-b px-3 py-4">
  <TenantSwitcher
    {tenants}
    currentTenantId={currentProject?.ref}
    onSwitch={switchProject}
  />
  <Button
    variant="ghost"
    size="sm"
    class="w-full justify-start text-brand"
    onclick={() => goto("/projects/create")}
  >
    <Plus data-icon="inline-start" />
    {$t("Project.new_project")}
  </Button>
</div>
