<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, FolderOpen, Table2, Braces } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface SchemaInfo {
    schema_name: string;
    schema_owner: string;
    table_count: number;
    function_count: number;
  }

  const projectRef = $derived(page.params.ref);

  const SCHEMAS_SQL = `
    SELECT 
      n.nspname as schema_name,
      pg_catalog.pg_get_userbyid(n.nspowner) as schema_owner,
      (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind = 'r')::int as table_count,
      (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid AND p.prokind = 'f')::int as function_count
    FROM pg_namespace n
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname != 'information_schema'
    ORDER BY n.nspname;
  `;

  const schemasQuery = createQuery(() => ({
    queryKey: ["database_schemas", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: SCHEMAS_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as SchemaInfo[];
    }
  }));

  const schemas = $derived((schemasQuery.data as SchemaInfo[]) || []);
  const isLoading = $derived(schemasQuery.isPending);
  const error = $derived(schemasQuery.error?.message || null);
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">{$t("Schemas.title")}</h1>
    <p class="text-sm text-muted-foreground mt-1">{$t("Schemas.subtitle")}</p>
  </div>

  {#if isLoading}
    <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
      <p class="text-xs font-mono uppercase tracking-widest">{$t("Schemas.loading")}</p>
    </div>
  {:else if error}
    <div class="p-4"><div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div></div>
  {:else}
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {#each schemas as schema}
        <div class="p-5 rounded-xl border bg-card hover:border-brand/30 transition-all group">
          <div class="flex items-center gap-3 mb-3">
            <div class="w-9 h-9 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
              <FolderOpen size={18} />
            </div>
            <div>
              <span class="font-mono font-semibold text-sm">{schema.schema_name}</span>
              <p class="text-[10px] text-muted-foreground">{$t("Schemas.owner")}: {schema.schema_owner}</p>
            </div>
          </div>
          <div class="flex items-center gap-4 pt-3 border-t border-border/30">
            <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Table2 size={12} />
              <span class="font-bold tabular-nums">{schema.table_count}</span>
              <span>{$t("Schemas.tables")}</span>
            </div>
            <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Braces size={12} />
              <span class="font-bold tabular-nums">{schema.function_count}</span>
              <span>{$t("Schemas.functions")}</span>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
