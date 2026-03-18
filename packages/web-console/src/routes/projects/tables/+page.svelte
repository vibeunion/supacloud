<script lang="ts">
  import TableSidebar from "$lib/components/TableSidebar.svelte";
  import { 
    RefreshCcw, 
    Plus, 
    Download, 
    Filter as FilterIcon,
    ArrowUpDown,
    Table as TableIcon,
    Search,
    ChevronLeft,
    ChevronRight,
    Loader2
  } from "lucide-svelte";
  import { cn } from "$lib/utils";

  let { data } = $props();

  let selectedTable = $state<any>(null);
  
  // Set initial table once data is available
  $effect(() => {
    if (!selectedTable && data.tables.length > 0) {
      selectedTable = data.tables[0];
    }
  });

  let tableData = $state<any[]>([]);
  let columns = $state<string[]>([]);
  let isLoading = $state(false);
  let totalRows = $state(0);
  let page = $state(1);
  let pageSize = $state(50);

  async function loadTableData(table: any) {
    if (!table) return;
    selectedTable = table;
    isLoading = true;
    
    try {
      const query = `SELECT * FROM "${table.schema}"."${table.name}" LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRef: data.project?.ref || 'default', query })
      });
      
      const result = await res.json();
      if (result.data) {
        tableData = result.data;
        columns = tableData.length > 0 ? Object.keys(tableData[0]) : [];
        totalRows = result.rowCount || 0;
      }
    } catch (err) {
      console.error('Failed to load table data:', err);
    } finally {
      isLoading = false;
    }
  }

  // Effect to load data when page changes or table changes
  $effect(() => {
    if (selectedTable) {
      loadTableData(selectedTable);
    }
  });
</script>

<div class="flex h-[calc(100vh-10rem)] border rounded-lg overflow-hidden bg-card">
  <!-- Left Side: Table Navigation -->
  <TableSidebar 
    tables={data.tables} 
    schemas={data.schemas} 
    selectedTable={selectedTable}
    onSelectTable={(t) => { page = 1; selectedTable = t; }}
  />

  <!-- Right Side: Data Grid Area -->
  <div class="flex-1 flex flex-col min-w-0 bg-background/30">
    <!-- Toolbar -->
    <div class="h-12 border-b flex items-center px-4 justify-between bg-secondary/10 shrink-0">
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-1.5 px-2 py-1 bg-secondary/50 rounded border text-xs font-medium">
          <TableIcon class="w-3.5 h-3.5" />
          {selectedTable?.name || 'No table selected'}
        </div>
        <div class="h-4 w-px bg-border"></div>
        <div class="flex items-center gap-1">
          <button class="p-1.5 hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground transition-all">
            <FilterIcon class="w-4 h-4" />
          </button>
          <button class="p-1.5 hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground transition-all">
            <ArrowUpDown class="w-4 h-4" />
          </button>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button 
          onclick={() => loadTableData(selectedTable)}
          class="p-1.5 hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground transition-all"
        >
          <RefreshCcw class={cn("w-4 h-4", isLoading && "animate-spin")} />
        </button>
        <button class="flex items-center gap-1.5 px-3 py-1.5 bg-brand text-white rounded-md text-xs font-semibold hover:opacity-90">
          <Plus class="w-3.5 h-3.5" />
          Insert row
        </button>
        <button class="flex items-center gap-1.5 px-3 py-1.5 border rounded-md text-xs font-semibold hover:bg-secondary/50">
          <Download class="w-3.5 h-3.5" />
          Export
        </button>
      </div>
    </div>

    <!-- Data Grid -->
    <div class="flex-1 overflow-auto relative min-h-0 bg-background">
      {#if isLoading}
        <div class="absolute inset-0 bg-background/50 flex flex-col items-center justify-center z-10 space-y-3">
          <Loader2 class="w-8 h-8 animate-spin text-brand" />
          <p class="text-sm text-muted-foreground font-medium">Loading data...</p>
        </div>
      {/if}

      {#if tableData.length > 0}
        <table class="w-full text-sm text-left border-separate border-spacing-0">
          <thead class="sticky top-0 bg-secondary/30 backdrop-blur-sm z-20 border-b shadow-sm">
            <tr>
              <th class="w-12 px-2 py-3 border-b border-r bg-secondary/10"></th>
              {#each columns as col}
                <th class="px-4 py-3 border-b border-r font-semibold text-muted-foreground">
                  <div class="flex items-center justify-between">
                    <span>{col}</span>
                    <span class="text-[10px] opacity-30">#</span>
                  </div>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody class="divide-y">
            {#each tableData as row, i}
              <tr class="hover:bg-brand/5 group transition-colors">
                <td class="px-2 py-2 border-r bg-secondary/5 text-center text-xs text-muted-foreground tabular-nums">
                  {i + 1 + (page - 1) * pageSize}
                </td>
                {#each columns as col}
                  <td class="px-4 py-2 border-r truncate max-w-[200px] font-mono text-xs">
                    {#if row[col] === null}
                      <span class="text-muted-foreground/30 italic">NULL</span>
                    {:else if typeof row[col] === 'object'}
                      <span class="text-blue-400">{JSON.stringify(row[col])}</span>
                    {:else}
                      {row[col]}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      {:else if !isLoading}
        <div class="flex flex-col items-center justify-center h-full text-muted-foreground space-y-4">
          <div class="p-4 rounded-full bg-secondary/30">
            <TableIcon class="w-12 h-12 opacity-20" />
          </div>
          <div class="text-center">
            <h3 class="font-semibold text-foreground">No data found</h3>
            <p class="text-sm">This table is empty or the query returned no results.</p>
          </div>
          <button 
            onclick={() => loadTableData(selectedTable)}
            class="px-4 py-2 text-brand font-medium hover:underline text-sm"
          >
            Try refreshing
          </button>
        </div>
      {/if}
    </div>

    <!-- Pagination Footer -->
    <div class="h-12 border-t flex items-center px-4 justify-between bg-secondary/10 shrink-0 text-xs text-muted-foreground">
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-1">
          <span>Page</span>
          <span class="font-medium text-foreground">{page}</span>
        </div>
        <div class="flex items-center gap-2">
          <button 
            disabled={page === 1}
            onclick={() => page--}
            class="p-1 hover:bg-secondary rounded disabled:opacity-30"
          >
            <ChevronLeft class="w-4 h-4" />
          </button>
          <button 
            disabled={tableData.length < pageSize}
            onclick={() => page++}
            class="p-1 hover:bg-secondary rounded disabled:opacity-30"
          >
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>
      </div>

      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2">
          <span>Limit:</span>
          <select 
            bind:value={pageSize}
            class="bg-transparent border-none focus:ring-0 p-0 font-medium"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={250}>250</option>
          </select>
        </div>
        <div>
          Showing <span class="font-medium text-foreground">{tableData.length}</span> rows
        </div>
      </div>
    </div>
  </div>
</div>
