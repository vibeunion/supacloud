<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { FolderOpen, Table2, Braces } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import PagePattern from "@svadmin/ui/components/PagePattern.svelte";
  import FilterToolbar from "@svadmin/ui/components/content/FilterToolbar.svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";

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
  let schemaQuery = $state("");
  const normalizedSchemaQuery = $derived(schemaQuery.trim().toLocaleLowerCase());
  const filteredSchemas = $derived(
    normalizedSchemaQuery
      ? schemas.filter((schema) =>
          [schema.schema_name, schema.schema_owner].join(" ").toLocaleLowerCase().includes(normalizedSchemaQuery),
        )
      : schemas,
  );
  const pageState = $derived.by(() => {
    if (isLoading) return "loading" as const;
    if (error) return "error" as const;
    if (schemas.length === 0) return "empty" as const;
    return "ready" as const;
  });

  const SCHEMA_DESCRIPTION_KEYS: Record<string, string> = {
    public: "Schemas.public_description",
    auth: "Schemas.auth_description",
    storage: "Schemas.storage_description",
    extensions: "Schemas.extensions_description",
  };

  function schemaDescription(schemaName: string): string {
    const key = SCHEMA_DESCRIPTION_KEYS[schemaName.toLowerCase()];
    return $t(key || "Schemas.custom_description");
  }
</script>

<PagePattern
  kind="list"
  pageId="database-schemas"
  title={$t("Schemas.title")}
  description={$t("Schemas.subtitle")}
  state={pageState}
  stateTitle={pageState === "error" ? (error || $t("Common.error")) : pageState === "empty" ? $t("Schemas.empty") : $t("Schemas.loading")}
  stateDescription={pageState === "error" ? error || undefined : undefined}
  retry={() => { void schemasQuery.refetch(); }}
  class="h-full"
>
  {#snippet toolbar()}
    <FilterToolbar bind:query={schemaQuery} placeholder={$t("Schemas.search")} clearLabel={$t("Common.clear_search")} />
  {/snippet}

  {#if filteredSchemas.length === 0}
    <DataState state="filtered-empty" title={$t("Common.no_matches")} description={$t("Common.no_matches_hint")} />
  {:else}
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {#each filteredSchemas as schema (schema.schema_name)}
        <div class="p-5 rounded-xl border bg-card hover:border-brand/30 transition-all group">
          <div class="flex items-center gap-3 mb-3">
            <div class="w-9 h-9 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
              <FolderOpen size={18} />
            </div>
            <div>
              <span title={schema.schema_name} class="font-mono font-semibold text-sm">{schema.schema_name}</span>
              <p class="text-[10px] text-muted-foreground">{schemaDescription(schema.schema_name)}</p>
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
</PagePattern>
