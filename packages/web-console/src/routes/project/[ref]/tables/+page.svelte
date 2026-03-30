<script lang="ts">
  import { page } from "$app/state";
  import { AutoTable } from "@svadmin/ui";
  import { t } from "svelte-i18n";
  import { TableProperties } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);
</script>

<div class="flex flex-col space-y-4">
  <div class="flex items-center gap-3 mb-2">
    <h1 class="text-2xl font-bold">{$t("Navigation.table_editor") || "Database Tables"}</h1>
  </div>

  <div class="flex-1 rounded-xl bg-background overflow-hidden relative min-h-[500px] border">
    {#key projectRef}
      <AutoTable 
        resourceName={`v1/projects/${projectRef}/database/tables`} 
      >
        {#snippet defaultCellRenderer({ field, value, record })}
          {#if field.key === 'table_name'}
            <div class="flex items-center gap-2">
              <TableProperties size={14} class="text-brand" />
              <a href={`/project/${projectRef}/tables/${record.table_schema}/${value}`} class="font-mono font-medium text-sm text-foreground hover:text-brand hover:underline transition-colors block py-1">
                {value}
              </a>
            </div>
          {:else if field.key === 'table_schema'}
            <span class="px-2 py-0.5 bg-brand/10 text-brand text-[10px] rounded-full uppercase font-medium tracking-wider">
              {value}
            </span>
          {:else if field.key === 'table_type'}
            <span class="text-xs text-muted-foreground">{value}</span>
          {:else if field.key === 'row_estimate'}
            <span class="text-xs text-muted-foreground tabular-nums">~ {value} rows</span>
          {:else}
            {value}
          {/if}
        {/snippet}
      </AutoTable>
    {/key}
  </div>
</div>
