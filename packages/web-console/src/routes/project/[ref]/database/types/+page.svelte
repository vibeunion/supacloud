<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Tag, ListOrdered } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface EnumType {
    type_name: string;
    schema_name: string;
    owner: string;
    enum_values: string;
  }

  const projectRef = $derived(page.params.ref);

  const ENUM_SQL = `
    SELECT 
      t.typname as type_name,
      n.nspname as schema_name,
      pg_catalog.pg_get_userbyid(t.typowner) as owner,
      string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) as enum_values
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON t.typnamespace = n.oid
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname != 'information_schema'
    GROUP BY t.typname, n.nspname, t.typowner
    ORDER BY n.nspname, t.typname;
  `;

  const typesQuery = createQuery(() => ({
    queryKey: ["database_types", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: ENUM_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as EnumType[];
    }
  }));

  const types = $derived((typesQuery.data as EnumType[]) || []);
  const isLoading = $derived(typesQuery.isPending);
  const error = $derived(typesQuery.error?.message || null);
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("EnumTypes.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("EnumTypes.subtitle")}</p>
    </div>
    {#if !isLoading && types.length > 0}
      <span class="px-2.5 py-1 rounded-full bg-brand/10 text-brand text-xs font-bold">{types.length}</span>
    {/if}
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("EnumTypes.loading")}</p>
      </div>
    {:else if error}
      <div class="p-4"><div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div></div>
    {:else if types.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3 opacity-40">
        <ListOrdered size={40} strokeWidth={1} />
        <p class="text-sm">{$t("EnumTypes.no_types")}</p>
      </div>
    {:else}
      <div class="overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("EnumTypes.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("EnumTypes.schema")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("EnumTypes.owner")}</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("EnumTypes.values")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each types as typ}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <Tag size={13} class="text-violet-500" />
                    <span class="font-mono font-semibold">{typ.type_name}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 text-muted-foreground">{typ.schema_name}</td>
                <td class="px-3 py-2.5 text-muted-foreground">{typ.owner}</td>
                <td class="px-4 py-2.5">
                  <div class="flex gap-1 flex-wrap">
                    {#each typ.enum_values.split(", ") as val}
                      <span class="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 text-[10px] font-mono font-medium">{val}</span>
                    {/each}
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
