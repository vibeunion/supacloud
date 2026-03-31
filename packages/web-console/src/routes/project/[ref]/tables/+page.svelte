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
      {#snippet tableNameRenderer({ value, record }: { value: any, record: any })}
        <div class="flex items-center gap-2">
          <TableProperties size={14} class="text-brand" />
          <a href={`/project/${projectRef}/tables/${record.table_schema}/${value}`} class="font-mono font-medium text-sm text-foreground hover:text-brand hover:underline transition-colors block py-1">
            {value}
          </a>
        </div>
      {/snippet}

      {#snippet schemaRenderer({ value }: { value: any })}
        <span class="px-2 py-0.5 bg-brand/10 text-brand text-[10px] rounded-full uppercase font-medium tracking-wider">
          {value}
        </span>
      {/snippet}

      {#snippet typeRenderer({ value }: { value: any })}
        <span class="text-xs text-muted-foreground">{value}</span>
      {/snippet}

      {#snippet rowsRenderer({ value }: { value: any })}
        <span class="text-xs text-muted-foreground tabular-nums">~ {value} rows</span>
      {/snippet}

      <AutoTable 
        resourceName={`v1/projects/${projectRef}/database/tables`} 
        columns={{ table_name: tableNameRenderer, table_schema: schemaRenderer, table_type: typeRenderer, row_estimate: rowsRenderer }}
      />
    {/key}
  </div>
</div>
