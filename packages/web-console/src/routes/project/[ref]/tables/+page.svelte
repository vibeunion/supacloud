<script lang="ts">
  import { page } from "$app/state";
  import { AutoTable } from "@svadmin/ui";
  import { apiClient } from "$lib/api";
  import { createMutation } from "@tanstack/svelte-query";
  import { t } from "svelte-i18n";
  import { toast } from "svelte-sonner";
  import { Loader2, Plus, TableProperties, Trash2 } from "lucide-svelte";

  const columnTypes = [
    "bigint",
    "boolean",
    "date",
    "double precision",
    "integer",
    "jsonb",
    "numeric",
    "real",
    "text",
    "time",
    "timestamp",
    "timestamptz",
    "uuid",
  ] as const;

  type TableColumnType = typeof columnTypes[number];

  interface TableColumnDraft {
    name: string;
    type: TableColumnType;
    nullable: boolean;
    primaryKey?: boolean;
    identity?: boolean;
  }

  const projectRef = $derived(page.params.ref!);
  let tableName = $state("");
  let tableListEpoch = $state(0);
  let columns = $state<TableColumnDraft[]>(initialColumns());

  function initialColumns(): TableColumnDraft[] {
    return [{ name: "id", type: "bigint", nullable: false, primaryKey: true, identity: true }];
  }

  function addColumn(): void {
    if (columns.length < 64) columns = [...columns, { name: "", type: "text", nullable: true }];
  }

  function removeColumn(index: number): void {
    if (index > 0) columns = columns.filter((_, columnIndex) => columnIndex !== index);
  }

  const createTableMutation = createMutation(() => ({
    mutationFn: async () => {
      const response = await apiClient(`/v1/projects/${projectRef}/database/tables`, {
        method: "POST",
        body: JSON.stringify({ name: tableName.trim(), columns }),
      });
      const payload = await response.json() as { message?: unknown; error?: unknown };
      if (!response.ok) {
        const message = typeof payload.message === "string"
          ? payload.message
          : typeof payload.error === "string" ? payload.error : $t("Tables.create_failed");
        throw new Error(message);
      }
      return payload;
    },
    onSuccess: () => {
      toast.success($t("Tables.create_success", { values: { name: tableName.trim() } }));
      tableName = "";
      columns = initialColumns();
      tableListEpoch += 1;
    },
  }));
</script>

<div class="flex flex-col space-y-4">
  <div class="flex items-center gap-3">
    <div>
      <h1 class="text-2xl font-bold">{$t("Navigation.table_editor") || "Database Tables"}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Tables.description")}</p>
    </div>
  </div>

  <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
    <div class="rounded-xl bg-background overflow-hidden relative min-h-[500px] border">
      {#key `${projectRef}-${tableListEpoch}`}
        {#snippet tableNameRenderer({ value, record }: { value: any, record: any })}
          <div class="flex items-center gap-2">
            <TableProperties size={14} class="text-brand" />
            <a href={`/project/${projectRef}/tables/${record.table_schema}/${value}`} class="font-mono font-medium text-sm text-foreground hover:text-brand hover:underline transition-colors block py-1">
              {value}
            </a>
          </div>
        {/snippet}

        {#snippet schemaRenderer({ value }: { value: any })}
          <span class="px-2 py-0.5 bg-brand/10 text-brand text-[10px] rounded-full uppercase font-medium tracking-wider">
            {value}
          </span>
        {/snippet}

        {#snippet typeRenderer({ value }: { value: any })}
          <span class="text-xs text-muted-foreground">{value}</span>
        {/snippet}

        {#snippet rowsRenderer({ value }: { value: any })}
          <span class="text-xs text-muted-foreground tabular-nums">{$t("Tables.estimated_rows", { values: { count: value } })}</span>
        {/snippet}

        <AutoTable
          resourceName={`v1/projects/${projectRef}/database/tables`}
          columns={{ table_name: tableNameRenderer, table_schema: schemaRenderer, table_type: typeRenderer, row_estimate: rowsRenderer }}
        />
      {/key}
    </div>

    <section class="rounded-xl border bg-card overflow-hidden h-fit">
      <div class="border-b px-5 py-4">
        <h2 class="font-semibold text-sm flex items-center gap-2"><Plus size={16} /> {$t("Tables.create_title")}</h2>
        <p class="text-xs text-muted-foreground mt-1">{$t("Tables.create_description")}</p>
      </div>
      <form class="p-5 space-y-4" onsubmit={(event) => { event.preventDefault(); createTableMutation.mutate(); }}>
        <label class="block space-y-1.5">
          <span class="text-xs font-medium text-muted-foreground">{$t("Tables.table_name")}</span>
          <input bind:value={tableName} required maxlength="63" pattern="[A-Za-z_][A-Za-z0-9_]*" class="w-full px-3 py-2 rounded-md border bg-background text-sm font-mono" placeholder="orders" autocomplete="off" />
        </label>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">{$t("Tables.columns")}</span>
            <button type="button" onclick={addColumn} disabled={columns.length >= 64} class="inline-flex items-center gap-1 text-xs text-brand hover:underline disabled:opacity-50 disabled:no-underline">
              <Plus size={13} /> {$t("Tables.add_column")}
            </button>
          </div>
          {#each columns as column, index (index)}
            <div class="grid grid-cols-[minmax(0,1fr)_112px_auto] gap-2 items-center">
              <input bind:value={column.name} required maxlength="63" pattern="[A-Za-z_][A-Za-z0-9_]*" class="min-w-0 px-2.5 py-2 rounded-md border bg-background text-xs font-mono" aria-label={$t("Tables.column_name_aria", { values: { index: index + 1 } })} />
              <select bind:value={column.type} disabled={index === 0} class="px-2 py-2 rounded-md border bg-background text-xs font-mono disabled:opacity-70" aria-label={$t("Tables.column_type_aria", { values: { index: index + 1 } })}>
                {#each columnTypes as type}
                  <option value={type}>{type}</option>
                {/each}
              </select>
              {#if index === 0}
                <span class="text-[10px] text-muted-foreground whitespace-nowrap">{$t("Tables.primary_key")}</span>
              {:else}
                <button type="button" onclick={() => removeColumn(index)} class="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10" aria-label={$t("Tables.remove_column_aria", { values: { name: column.name || index + 1 } })}>
                  <Trash2 size={14} />
                </button>
              {/if}
              {#if index > 0}
                <label class="col-span-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" bind:checked={column.nullable} class="rounded" /> {$t("Tables.nullable")}
                </label>
              {/if}
            </div>
          {/each}
        </div>

        {#if createTableMutation.error}
          <div class="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">{createTableMutation.error.message}</div>
        {/if}
        <button disabled={createTableMutation.isPending || !tableName.trim() || columns.some((column) => !column.name.trim())} class="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-brand text-white text-sm font-medium disabled:opacity-50">
          {#if createTableMutation.isPending}
            <Loader2 size={14} class="animate-spin" />
          {:else}
            <Plus size={14} />
          {/if}
          {$t("Tables.create_action")}
        </button>
      </form>
    </section>
  </div>
</div>
