<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Package, Check, X, Search } from "lucide-svelte";

  interface Extension {
    name: string;
    default_version: string;
    installed_version: string | null;
    schema: string | null;
    comment: string;
  }

  let extensions = $state<Extension[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);
  let searchQuery = $state("");

  const projectRef = $derived(page.params.ref);

  const EXT_SQL = `
    SELECT 
      e.name, 
      e.default_version, 
      ei.extversion as installed_version,
      n.nspname as schema,
      e.comment 
    FROM pg_available_extensions e 
    LEFT JOIN pg_extension ei ON e.name = ei.extname 
    LEFT JOIN pg_namespace n ON ei.extnamespace = n.oid
    ORDER BY (ei.extversion IS NOT NULL) DESC, e.name;
  `;

  async function fetchExtensions() {
    isLoading = true;
    error = null;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: EXT_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      extensions = Array.isArray(data) ? data : data.rows || [];
    } catch (err: any) {
      error = err.message;
    } finally {
      isLoading = false;
    }
  }

  let togglingExt = $state<string | null>(null);

  async function toggleExtension(ext: Extension) {
    togglingExt = ext.name;
    const isEnabling = !ext.installed_version;
    const sql = isEnabling 
      ? `CREATE EXTENSION IF NOT EXISTS "${ext.name}" CASCADE;`
      : `DROP EXTENSION IF EXISTS "${ext.name}" CASCADE;`;

    try {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      
      // Update local state instead of doing full refetch for better UX
      extensions = extensions.map(e => {
        if (e.name === ext.name) {
          return { ...e, installed_version: isEnabling ? e.default_version : null };
        }
        return e;
      });
    } catch (err: any) {
      error = err.message;
      setTimeout(() => error = null, 5000);
    } finally {
      togglingExt = null;
    }
  }

  onMount(() => { fetchExtensions(); });

  const filteredExtensions = $derived(
    searchQuery
      ? extensions.filter(e => e.name.toLowerCase().includes(searchQuery.toLowerCase()) || (e.comment || "").toLowerCase().includes(searchQuery.toLowerCase()))
      : extensions
  );

  const enabledCount = $derived(extensions.filter(e => e.installed_version).length);
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("Extensions.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Extensions.subtitle")}</p>
    </div>
    {#if !isLoading}
      <div class="flex items-center gap-3 text-xs text-muted-foreground">
        <span class="px-2 py-1 rounded bg-green-500/10 text-green-600 font-bold">{enabledCount} {$t("Extensions.enabled")}</span>
        <span class="px-2 py-1 rounded bg-muted text-muted-foreground font-bold">{extensions.length - enabledCount} {$t("Extensions.disabled")}</span>
      </div>
    {/if}
  </div>

  <!-- Search -->
  <div class="relative w-64">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input
      bind:value={searchQuery}
      placeholder={$t("Extensions.search")}
      class="w-full pl-9 pr-3 py-1.5 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
    />
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden flex flex-col">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("Extensions.loading")}</p>
      </div>
    {:else}
      {#if error}
        <div class="p-4 border-b">
          <div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div>
        </div>
      {/if}
      <div class="overflow-auto flex-1">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0 z-10">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Extensions.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Extensions.version")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Extensions.schema")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Extensions.description")}</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground text-right">Status / Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each filteredExtensions as ext}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <Package size={13} class={ext.installed_version ? "text-green-500" : "text-muted-foreground/40"} />
                    <span class="font-mono font-medium">{ext.name}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 font-mono text-muted-foreground tabular-nums">
                  {ext.installed_version || ext.default_version}
                </td>
                <td class="px-3 py-2.5 font-mono text-muted-foreground">
                  {ext.schema || "—"}
                </td>
                <td class="px-3 py-2.5 text-muted-foreground max-w-sm truncate">{ext.comment || "—"}</td>
                <td class="px-4 py-2.5 text-right">
                  <div class="flex items-center justify-end gap-2">
                    {#if ext.installed_version}
                      <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 text-[10px] font-bold">
                        <Check size={10} /> {$t("Extensions.enabled")}
                      </span>
                      <button onclick={() => toggleExtension(ext)} disabled={togglingExt === ext.name}
                        class="ml-2 px-2 py-1 text-[10px] rounded border border-destructive/20 text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-1 disabled:opacity-50">
                        {#if togglingExt === ext.name}<Loader2 size={10} class="animate-spin" />{:else}<X size={10} />{/if} Disable
                      </button>
                    {:else}
                      <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px]">
                        <X size={10} /> {$t("Extensions.disabled")}
                      </span>
                      <button onclick={() => toggleExtension(ext)} disabled={togglingExt === ext.name}
                        class="ml-2 px-2 py-1 text-[10px] rounded border border-brand/20 text-brand hover:bg-brand/10 transition-colors flex items-center gap-1 disabled:opacity-50">
                        {#if togglingExt === ext.name}<Loader2 size={10} class="animate-spin" />{:else}<Check size={10} />{/if} Enable
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
