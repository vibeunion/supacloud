<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import {
    buildTableRowsResource,
    parseTableColumnsResponse,
    tableColumnsEndpoint,
    tableRowsResourceName,
  } from "$lib/admin/resources";
  import { matchingTableTenant, type TableRowsIdentity } from "$lib/admin/table-rows";
  import { requestValidatedJson } from "$lib/validated-json";
  import {
    captureAdminContext,
    provideAdminContext,
    type ResourceDefinition,
    type TenantContext,
  } from "@svadmin/core";
  import AutoTable from "@svadmin/ui/components/AutoTable.svelte";
  import { ChevronRight, Database, Table as TableIcon } from "lucide-svelte";

  const parentAdminContext = captureAdminContext();
  const projectRef = $derived(page.params.ref ?? "");
  const schema = $derived(page.params.schema ?? "");
  const tableName = $derived(page.params.table_name ?? "");
  const currentResourceName = $derived(tableRowsResourceName(projectRef, schema, tableName));
  let tableResource = $state<ResourceDefinition>();
  let loading = $state(true);
  let errorMessage = $state("");
  let retryKey = $state(0);

  provideAdminContext({
    get providerBundle() { return parentAdminContext.providerBundle; },
    get resources() {
      if (tableResource?.name !== currentResourceName) return parentAdminContext.resources;
      return [
        ...parentAdminContext.resources.filter((resource) => resource.name !== tableResource?.name),
        tableResource,
      ];
    },
    get tenant() { return parentAdminContext.tenant; },
  });

  function loadTableResource(
    identity: TableRowsIdentity,
    tenant: TenantContext | undefined,
    signal: AbortSignal,
  ) {
    if (!matchingTableTenant(tenant, identity)) throw new Error("Project context unavailable");
    return requestValidatedJson(
      tableColumnsEndpoint(identity.projectRef, identity.schema, identity.tableName),
      apiClient,
      (payload) => buildTableRowsResource({ ...identity, columns: parseTableColumnsResponse(payload) }),
      { signal },
    );
  }

  $effect(() => {
    void retryKey;
    const ref = projectRef;
    const schemaName = schema;
    const name = tableName;
    const tenant = parentAdminContext.tenant;
    const identity = { projectRef: ref, schema: schemaName, tableName: name };
    const controller = new AbortController();
    let cancelled = false;

    tableResource = undefined;
    errorMessage = "";
    loading = true;

    if (!matchingTableTenant(tenant, identity)) {
      errorMessage = "Project context unavailable";
      loading = false;
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    void loadTableResource(identity, tenant, controller.signal)
      .then((resource) => {
        if (!cancelled) tableResource = resource;
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) {
          errorMessage = "Failed to load table columns";
        }
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  });
</script>

<div class="flex flex-col space-y-4">
  <div class="flex items-center gap-2 rounded-md border bg-muted/20 px-4 py-2 text-sm text-muted-foreground">
    <Database size={14} />
    <a
      href={resolve("/project/[ref]/tables", { ref: projectRef })}
      class="transition-colors hover:text-foreground"
    >Tables</a>
    <ChevronRight size={14} class="opacity-50" />
    <span class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{schema}</span>
    <ChevronRight size={14} class="opacity-50" />
    <TableIcon size={14} class="text-brand" />
    <span class="font-mono text-xs font-semibold tracking-wide text-foreground">{tableName}</span>
  </div>

  <div class="mb-2 mt-2 flex items-center gap-3">
    <h1 class="text-2xl font-bold">Table Data</h1>
    <span class="rounded-full bg-brand/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-brand">Auto Viewer</span>
  </div>

  <div class="relative min-h-[600px] flex-1 overflow-hidden rounded-xl border bg-background shadow-sm">
    {#if loading}
      <div class="flex min-h-[600px] items-center justify-center text-sm text-muted-foreground" aria-live="polite">
        Loading table columns…
      </div>
    {:else if errorMessage}
      <div class="flex min-h-[600px] flex-col items-center justify-center gap-3 px-6 text-center text-sm text-destructive" role="alert">
        <span>{errorMessage}</span>
        <button
          type="button"
          onclick={() => { retryKey += 1; }}
          class="rounded-lg border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted/50"
        >Retry</button>
      </div>
    {:else if tableResource?.name === currentResourceName}
      {#snippet customDefaultRenderer({ value }: { value: unknown })}
        <div class="max-w-[200px] truncate" title={String(value)}>
          <span class:text-blue-500={typeof value === "number" || typeof value === "boolean"} class:font-mono={typeof value === "number" || typeof value === "boolean"} class:tabular-nums={typeof value === "number" || typeof value === "boolean"} class="text-xs text-foreground">
            {value === null ? "null" : String(value)}
          </span>
        </div>
      {/snippet}

      {#key currentResourceName}
        <AutoTable
          resourceName={currentResourceName}
          defaultCellRenderer={customDefaultRenderer}
          selectable={false}
        />
      {/key}
    {/if}
  </div>
</div>
