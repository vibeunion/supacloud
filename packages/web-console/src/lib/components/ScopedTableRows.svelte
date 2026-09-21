<script lang="ts">
  import { provideAdminContext, type ProviderBundle, type ResourceDefinition, type TenantContext } from "@svadmin/core";
  import AutoTable from "@svadmin/ui/components/AutoTable.svelte";
  import { formatTableValue } from "$lib/admin/table-rows";

  let { resource, parentResources, providerBundle, tenant }: {
    resource: ResourceDefinition;
    parentResources: ResourceDefinition[];
    providerBundle: ProviderBundle;
    tenant: TenantContext;
  } = $props();

  provideAdminContext({
    get providerBundle() { return providerBundle; },
    get resources() { return [...parentResources.filter(item => item.name !== resource.name), resource]; },
    get tenant() { return tenant; },
  });
</script>

{#snippet customDefaultRenderer({ value }: { value: unknown })}
  {@const display = formatTableValue(value)}
  <div class="max-w-[200px] truncate" title={display}>
    <span
      class:text-blue-500={typeof value === "number" || typeof value === "boolean"}
      class:font-mono={typeof value === "number" || typeof value === "boolean"}
      class:tabular-nums={typeof value === "number" || typeof value === "boolean"}
      class="text-xs text-foreground"
    >{display}</span>
  </div>
{/snippet}

<AutoTable resourceName={resource.name} defaultCellRenderer={customDefaultRenderer} selectable={false} />
