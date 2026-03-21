<script lang="ts">
  import { onMount } from "svelte";
  import { cn } from "$lib/utils";
  import { Code2, Activity , Plus, Play, Table as TableIcon} from "lucide-svelte";

  import MonacoEditor from "$lib/components/MonacoEditor.svelte";

  let tabs = $state([
    { id: '1', name: 'New Query', content: '-- Write your SQL here\nSELECT * FROM projects;', active: true },
    { id: '2', name: 'Users Check', content: 'SELECT count(*) FROM auth.users;', active: false }
  ]);

  let activeIndex = $derived(tabs.findIndex(t => t.active));

  let activeTab = $derived(tabs.find(t => t.active) || tabs[0]);
  let results = $state<Record<string, unknown>[]>([]);
  let isRunning = $state(false);

  function switchTab(id: string) {
    tabs = tabs.map(t => ({ ...t, active: t.id === id }));
  }

  function addTab() {
    const id = Math.random().toString(36).substring(7);
    tabs = [...tabs.map(t => ({ ...t, active: false })), { id, name: 'New Query', content: '', active: true }];
  }

  async function runQuery() {
    isRunning = true;
    // TODO: 這裡後續將對接直連 Bun SQL 或整合後的 API
    setTimeout(() => {
      results = [
        { id: 1, name: 'Project A', status: 'ACTIVE' },
        { id: 2, name: 'Project B', status: 'PAUSED' }
      ];
      isRunning = false;
    }, 500);
  }
</script>

<div class="h-[calc(100vh-10rem)] flex flex-col border rounded-lg overflow-hidden bg-card">
  <!-- Tab Bar -->
  <div class="flex items-center justify-between border-b bg-secondary/20 px-4 h-12">
    <div class="flex items-center -mb-px overflow-x-auto no-scrollbar">
      {#each tabs as tab}
        <button
          onclick={() => switchTab(tab.id)}
          class={cn(
            "flex items-center gap-2 px-4 h-12 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
            tab.active 
              ? "border-brand text-foreground bg-background/50" 
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <Code2 class="w-3.5 h-3.5" />
          {tab.name}
        </button>
      {/each}
      <button 
        onclick={addTab}
        class="p-2 ml-2 text-muted-foreground hover:text-foreground transition-colors"
      >
        <Plus class="w-4 h-4" />
      </button>
    </div>

    <div class="flex items-center gap-2">
      <button 
        onclick={runQuery}
        disabled={isRunning}
        class="flex items-center gap-2 px-3 py-1.5 bg-brand text-white rounded-md text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        <Play class="w-3.5 h-3.5 fill-current" />
        {isRunning ? 'Running...' : 'Run'}
      </button>
    </div>
  </div>

  <!-- Editor Container -->
  <div class="flex-1 flex flex-col min-h-0">
    <!-- Real Monaco Editor Integration -->
    <div class="flex-1 min-h-0 bg-background/30">
      {#if activeIndex !== -1}
        <MonacoEditor bind:value={tabs[activeIndex].content} />
      {/if}
    </div>

    <!-- Results Splitter (Simplified) -->
    <div class="h-1/3 border-t bg-card flex flex-col min-h-0">
      <div class="h-10 border-b flex items-center px-4 justify-between bg-secondary/10">
        <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Results</span>
        <span class="text-xs text-muted-foreground">{results.length} rows</span>
      </div>
      <div class="flex-1 overflow-auto">
        {#if results.length > 0}
          <table class="w-full text-sm text-left">
            <thead class="bg-secondary/20 sticky top-0">
              <tr>
                {#each Object.keys(results[0]) as key}
                  <th class="px-4 py-2 border-r last:border-r-0 font-medium">{key}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each results as row}
                <tr class="border-b hover:bg-secondary/10">
                  {#each Object.values(row) as val}
                    <td class="px-4 py-2 border-r last:border-r-0 font-mono text-xs">{val}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if isRunning}
          <div class="flex items-center justify-center h-full text-muted-foreground">
            <Activity class="w-4 h-4 animate-spin mr-2" />
            Executing query...
          </div>
        {:else}
          <div class="flex flex-col items-center justify-center h-full text-muted-foreground space-y-2">
            <TableIcon class="w-8 h-8 opacity-20" />
            <p>Run a query to see results</p>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

