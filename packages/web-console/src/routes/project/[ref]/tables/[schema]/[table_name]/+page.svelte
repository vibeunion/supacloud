<script lang="ts">
  import { page } from "$app/state";
  import { AutoTable } from "@svadmin/ui";
  import { t } from "svelte-i18n";
  import { ChevronRight, Database, Table as TableIcon } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);
  const schema = $derived(page.params.schema);
  const tableName = $derived(page.params.table_name);
</script>

<div class="flex flex-col space-y-4">
  <!-- Breadcrumbs -->
  <div class="flex items-center gap-2 text-sm text-muted-foreground bg-muted/20 px-4 py-2 rounded-md border">
    <Database size={14} />
    <a href={`/project/${projectRef}/tables`} class="hover:text-foreground transition-colors">Tables</a>
    <ChevronRight size={14} class="opacity-50" />
    <span class="font-mono text-xs px-1.5 py-0.5 bg-muted rounded">{schema}</span>
    <ChevronRight size={14} class="opacity-50" />
    <TableIcon size={14} class="text-brand" />
    <span class="font-mono text-foreground font-semibold text-xs tracking-wide">{tableName}</span>
  </div>

  <div class="flex items-center gap-3 mt-2 mb-2">
    <h1 class="text-2xl font-bold">Table Data</h1>
    <span class="px-2 py-0.5 bg-brand/10 text-brand text-[10px] font-mono rounded-full tracking-wider uppercase">Auto Viewer</span>
  </div>

  <div class="flex-1 rounded-xl bg-background overflow-hidden relative min-h-[600px] border shadow-sm">
    {#key `${projectRef}-${schema}-${tableName}`}
      <AutoTable 
        resourceName={`v1/projects/${projectRef}/database/tables/${schema}/${tableName}/rows`} 
      >
        {#snippet defaultCellRenderer({ field, value })}
           <div class="truncate max-w-[200px]" title={String(value)}>
             <span class="text-xs {typeof value === 'number' || typeof value === 'boolean' ? 'tabular-nums text-blue-500 font-mono' : 'text-foreground'}">
               {value === null ? 'null' : String(value)}
             </span>
           </div>
        {/snippet}
      </AutoTable>
    {/key}
  </div>
</div>
