<script lang="ts">
  import { cn } from "$lib/utils";
  import { 
    Database, 
    Table as TableIcon, 
    Search,
    ChevronRight,
    ChevronDown,
    Filter
  } from "lucide-svelte";

  let { tables = [], schemas = [], selectedTable = null, onSelectTable = (t: Record<string, unknown>) => {} } = $props();
  
  let searchTerm = $state("");
  let expandedSchemas = $state<Set<string>>(new Set(['public']));

  function toggleSchema(schema: string) {
    if (expandedSchemas.has(schema)) {
      expandedSchemas.delete(schema);
    } else {
      expandedSchemas.add(schema);
    }
    expandedSchemas = new Set(expandedSchemas);
  }

  let filteredTables = $derived(
    tables.filter((t) => 
      t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.schema.toLowerCase().includes(searchTerm.toLowerCase())
    )
  );
</script>

<div class="w-64 border-r flex flex-col h-full bg-card/50">
  <div class="p-4 space-y-4">
    <div class="relative">
      <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <input
        type="text"
        placeholder="Filter tables..."
        bind:value={searchTerm}
        class="w-full bg-secondary/50 border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand"
      />
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-2 pb-4 space-y-4">
    {#each schemas as schema}
      <div class="space-y-1">
        <button 
          onclick={() => toggleSchema(schema)}
          class="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          {#if expandedSchemas.has(schema)}
            <ChevronDown class="w-3.5 h-3.5" />
          {:else}
            <ChevronRight class="w-3.5 h-3.5" />
          {/if}
          {schema}
        </button>

        {#if expandedSchemas.has(schema)}
          <div class="space-y-0.5 ml-2 border-l pl-2">
            {#each filteredTables.filter((t) => t.schema === schema) as table}
              <button
                onclick={() => onSelectTable(table)}
                class={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors",
                  selectedTable?.name === table.name && selectedTable?.schema === table.schema
                    ? "bg-brand/10 text-brand font-medium"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                )}
              >
                <TableIcon class="w-3.5 h-3.5" />
                <span class="truncate">{table.name}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>
