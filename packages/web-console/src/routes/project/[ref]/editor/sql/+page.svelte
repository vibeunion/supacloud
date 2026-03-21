<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";

  let sql = $state("");
  let isSaving = $state(false);
  let saveTimeout: ReturnType<typeof setTimeout> | undefined;

  // 從 URL 獲取項目引用
  const projectRef = $derived(page.params.ref);
  const storageKey = $derived(`supacloud_${projectRef}_sql_draft`);

  onMount(() => {
    // 恢復上次保存的草稿
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      sql = saved;
    }
  });

  // 監聽 SQL 變動並防抖保存
  $effect(() => {
    if (sql !== undefined) {
      isSaving = true;
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        localStorage.setItem(storageKey, sql);
        isSaving = false;
        console.log('SQL Draft saved to localStorage');
      }, 1000);
    }
  });
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">SQL Editor</h1>
    {#if isSaving}
      <span class="text-xs text-muted-foreground animate-pulse leading-none">Saving draft...</span>
    {:else}
      <span class="text-xs text-muted-foreground leading-none">Draft saved</span>
    {/if}
  </div>

  <div class="flex-1 flex flex-col min-h-0 rounded-md border bg-background shadow-sm overflow-hidden">
    <!-- Toolbar -->
    <div class="flex items-center px-4 py-2 border-b bg-muted/30 gap-2">
      <button class="px-3 py-1 bg-brand text-white text-xs font-medium rounded hover:bg-brand/90 transition-colors">
        Run Query
      </button>
      <div class="h-4 w-[1px] bg-border mx-1"></div>
      <span class="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">PostgreSQL</span>
    </div>

    <!-- Simple Textarea for now (Monaco later) -->
    <textarea
      bind:value={sql}
      spellcheck="false"
      placeholder="-- Write your SQL here..."
      class="flex-1 w-full p-6 bg-transparent font-mono text-sm resize-none focus:outline-none leading-relaxed"
    ></textarea>
  </div>
  
  <p class="text-[10px] text-muted-foreground text-center">
    Drafts are automatically saved to your local browser storage.
  </p>
</div>
