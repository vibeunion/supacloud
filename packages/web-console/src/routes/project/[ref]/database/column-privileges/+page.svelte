<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Columns3, Check, X, ShieldCheck } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface ColumnPrivilege {
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    grantee: string;
    privilege_type: string;
    is_grantable: string;
  }

  interface TableRow {
    table_name: string;
    columns: ColumnInfo[];
  }

  interface ColumnInfo {
    column_name: string;
    data_type: string;
    privileges: Record<string, boolean>;
  }

  let selectedRole = $state("anon");

  const projectRef = $derived(page.params.ref);
  const roles = ["anon", "authenticated", "service_role"];

  const PRIV_SQL = `
    SELECT 
      c.table_schema,
      c.table_name,
      c.column_name,
      c.data_type,
      COALESCE(p.grantee, '') as grantee,
      COALESCE(p.privilege_type, '') as privilege_type,
      COALESCE(p.is_grantable, 'NO') as is_grantable
    FROM information_schema.columns c
    LEFT JOIN information_schema.column_privileges p 
      ON c.table_schema = p.table_schema 
      AND c.table_name = p.table_name 
      AND c.column_name = p.column_name
    WHERE c.table_schema = 'public'
    ORDER BY c.table_name, c.ordinal_position;
  `;

  const privilegesQuery = createQuery(() => ({
    queryKey: ["database_column_privileges", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: PRIV_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      const rows: ColumnPrivilege[] = data.rows || [];

      const tableMap = new Map<string, Map<string, ColumnInfo>>();
      for (const row of rows) {
        if (!tableMap.has(row.table_name)) {
          tableMap.set(row.table_name, new Map());
        }
        const colMap = tableMap.get(row.table_name)!;
        if (!colMap.has(row.column_name)) {
          colMap.set(row.column_name, {
            column_name: row.column_name,
            data_type: row.data_type,
            privileges: {}
          });
        }
        const col = colMap.get(row.column_name)!;
        if (row.grantee && row.privilege_type) {
          col.privileges[`${row.grantee}:${row.privilege_type}`] = true;
        }
      }

      return Array.from(tableMap.entries()).map(([table_name, colMap]) => ({
        table_name,
        columns: Array.from(colMap.values())
      }));
    }
  }));

  const tables = $derived((privilegesQuery.data as TableRow[]) || []);
  const isLoading = $derived(privilegesQuery.isPending);
  const error = $derived(privilegesQuery.error?.message || null);

  function hasPriv(col: ColumnInfo, role: string, priv: string): boolean {
    return col.privileges[`${role}:${priv}`] === true;
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("ColumnPrivileges.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("ColumnPrivileges.subtitle")}</p>
    </div>
    <div class="flex items-center gap-2">
      <ShieldCheck size={14} class="text-muted-foreground" />
      <span class="text-xs text-muted-foreground">{$t("ColumnPrivileges.role")}:</span>
      {#each roles as role}
        <button
          onclick={() => selectedRole = role}
          class="px-2.5 py-1 text-xs rounded-md transition-colors {selectedRole === role ? 'bg-brand text-white font-bold' : 'bg-muted/50 text-muted-foreground hover:bg-muted'}"
        >{role}</button>
      {/each}
    </div>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("ColumnPrivileges.loading")}</p>
      </div>
    {:else if error}
      <div class="p-4"><div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div></div>
    {:else if tables.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3 opacity-40">
        <Columns3 size={40} strokeWidth={1} />
        <p class="text-sm">{$t("ColumnPrivileges.no_tables")}</p>
      </div>
    {:else}
      <div class="overflow-auto max-h-[70vh]">
        {#each tables as tbl}
          <div class="border-b border-border/30">
            <div class="px-4 py-2 bg-muted/20 border-b border-border/20">
              <span class="font-mono font-bold text-xs text-brand">{tbl.table_name}</span>
            </div>
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="bg-muted/10">
                  <th class="px-4 py-1.5 font-semibold text-muted-foreground w-48">{$t("ColumnPrivileges.column")}</th>
                  <th class="px-3 py-1.5 font-semibold text-muted-foreground w-32">{$t("ColumnPrivileges.type")}</th>
                  <th class="px-3 py-1.5 font-semibold text-muted-foreground text-center w-20">{$t("ColumnPrivileges.select")}</th>
                  <th class="px-3 py-1.5 font-semibold text-muted-foreground text-center w-20">{$t("ColumnPrivileges.insert")}</th>
                  <th class="px-3 py-1.5 font-semibold text-muted-foreground text-center w-20">{$t("ColumnPrivileges.update")}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border/10">
                {#each tbl.columns as col}
                  <tr class="hover:bg-muted/5 transition-colors">
                    <td class="px-4 py-1.5 font-mono text-[11px]">{col.column_name}</td>
                    <td class="px-3 py-1.5 text-muted-foreground text-[10px]">{col.data_type}</td>
                    <td class="px-3 py-1.5 text-center">
                      {#if hasPriv(col, selectedRole, "SELECT")}
                        <Check size={12} class="inline text-green-500" />
                      {:else}
                        <X size={12} class="inline text-muted-foreground/20" />
                      {/if}
                    </td>
                    <td class="px-3 py-1.5 text-center">
                      {#if hasPriv(col, selectedRole, "INSERT")}
                        <Check size={12} class="inline text-green-500" />
                      {:else}
                        <X size={12} class="inline text-muted-foreground/20" />
                      {/if}
                    </td>
                    <td class="px-3 py-1.5 text-center">
                      {#if hasPriv(col, selectedRole, "UPDATE")}
                        <Check size={12} class="inline text-green-500" />
                      {:else}
                        <X size={12} class="inline text-muted-foreground/20" />
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
