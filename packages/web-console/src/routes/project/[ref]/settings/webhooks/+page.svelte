<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Webhook, Plus, Trash2, Loader2 } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import PagePattern from "@svadmin/ui/components/PagePattern.svelte";
  import FilterToolbar from "@svadmin/ui/components/content/FilterToolbar.svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";

  const projectRef = $derived(page.params.ref);

  interface WebhookEndpoint {
    id: string; // trigger name
    table: string;
    url: string;
    events: string[];
    enabled: boolean;
  }

  // Add State
  let showAdd = $state(false);
  let addError = $state<string | null>(null);
  let newName = $state("");
  let newUrl = $state("");
  let newTable = $state("");
  let selectedEvents = $state<string[]>([]);
  
  const queryClient = useQueryClient();

  const AVAILABLE_EVENTS = ["INSERT", "UPDATE", "DELETE"];

  const webhooksQuery = createQuery(() => ({
    queryKey: ["webhooks", projectRef],
    queryFn: async () => {
      const extensionRes = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_net') AS installed;" })
      });
      const extensionData = await extensionRes.json();
      const pgNetInstalled = extensionRes.ok && Boolean(extensionData.rows?.[0]?.installed);

      const sql = `
        SELECT
          t.tgname as id,
          c.relname as table,
          t.tgenabled != 'D' as enabled,
          pg_get_triggerdef(t.oid) as def
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public' AND t.tgname LIKE 'webhook_%';
      `;
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql })
      });
      const data = res.ok ? await res.json() : { rows: [] };
      const rows = pgNetInstalled ? (data.rows || []) : [];
      
      const endpoints: WebhookEndpoint[] = rows.map((r: Record<string, unknown>) => {
        const events = [];
        if (String(r.def).includes("INSERT")) events.push("INSERT");
        if (String(r.def).includes("UPDATE")) events.push("UPDATE");
        if (String(r.def).includes("DELETE")) events.push("DELETE");
        
        return {
          id: r.id as string,
          table: r.table as string,
          enabled: r.enabled as boolean,
          events,
          url: "Extracted from pg_trigger",
        };
      });

      const tblRes = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;" })
      });
      if (!tblRes.ok) return { endpoints, tables: [], pgNetInstalled };
      const tblData = await tblRes.json();
      const tables = (tblData.rows || []).map((t: Record<string, unknown>) => t.tablename as string);

      return { endpoints, tables, pgNetInstalled };
    }
  }));

  const endpoints = $derived(webhooksQuery.data?.endpoints || []);
  const tables = $derived(webhooksQuery.data?.tables || []);
  const isLoading = $derived(webhooksQuery.isPending);
  let webhookQuery = $state("");
  const normalizedWebhookQuery = $derived(webhookQuery.trim().toLocaleLowerCase());
  const filteredEndpoints = $derived(
    normalizedWebhookQuery
      ? endpoints.filter((endpoint) =>
          [endpoint.id, endpoint.table, ...endpoint.events]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedWebhookQuery),
        )
      : endpoints,
  );
  const pageState = $derived.by(() => {
    if (showAdd) return "ready" as const;
    if (isLoading) return "loading" as const;
    if (endpoints.length === 0) return "empty" as const;
    return "ready" as const;
  });

  const saveMutation = createMutation(() => ({
    mutationFn: async () => {
      const funcName = `webhook_func_${newName}`;
      const triggerName = `webhook_trig_${newName}`;
      const sql = `
        CREATE OR REPLACE FUNCTION public."${funcName}"()
        RETURNS TRIGGER AS $$
        BEGIN
          PERFORM net.http_post(
            url:='${newUrl}',
            body:=jsonb_build_object(
              'type', TG_OP,
              'table', TG_TABLE_NAME,
              'schema', TG_TABLE_SCHEMA,
              'record', row_to_json(NEW),
              'old_record', row_to_json(OLD)
            )
          );
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql SECURITY DEFINER;

        DROP TRIGGER IF EXISTS "${triggerName}" ON public."${newTable}";
        CREATE TRIGGER "${triggerName}"
        AFTER ${selectedEvents.join(" OR ")} ON public."${newTable}"
        FOR EACH ROW EXECUTE FUNCTION public."${funcName}"();
      `;

      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, mode: "migration" })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return data;
    },
    onSuccess: () => {
      showAdd = false;
      newName = ""; newUrl = ""; newTable = ""; selectedEvents = [];
      queryClient.invalidateQueries({ queryKey: ["webhooks", projectRef] });
    },
    onError: (err: unknown) => {
      addError = (err instanceof Error ? err.message : String(err)) || $t("Hooks.create_failed");
    }
  }));

  function saveWebhook() {
    if (!newName || !newUrl || !newTable || selectedEvents.length === 0) {
      addError = $t("Hooks.required_fields");
      return;
    }
    addError = null;
    saveMutation.mutate();
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async (id: string) => {
      const triggerName = id;
      const funcName = id.replace("webhook_trig_", "webhook_func_");
      const endpoint = endpoints.find(e => e.id === id);
      const tableName = endpoint?.table;
      
      const sql = `
        DROP TRIGGER IF EXISTS "${triggerName}" ON public."${tableName}";
        DROP FUNCTION IF EXISTS public."${funcName}"();
      `;
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, mode: "migration" })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.message || data?.error || $t("Hooks.delete_failed"));
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks", projectRef] });
    },
    onError: () => {
      alert($t("Hooks.delete_failed"));
    }
  }));

  function deleteWebhook(id: string) {
    if (!confirm($t("Hooks.delete_confirm", { values: { name: id } }))) return;
    deleteMutation.mutate(id);
  }
</script>

<PagePattern
  kind="list"
  pageId="database-webhooks"
  title={$t("Hooks.title")}
  description={$t("Hooks.subtitle")}
  state={pageState}
  stateTitle={pageState === "empty" ? $t("Hooks.no_hooks_title") : $t("Hooks.loading")}
  stateDescription={pageState === "empty" ? $t("Hooks.no_hooks_description") : undefined}
  class="h-full"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <span class="px-2.5 py-1 rounded-full bg-brand/10 text-brand text-xs font-bold">{$t("Hooks.count", { values: { count: endpoints.length } })}</span>
      <button
        onclick={() => showAdd = !showAdd}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
      >
        <Plus size={14} /> {$t("Hooks.add")}
      </button>
    </div>
  {/snippet}
  {#snippet toolbar()}
    <FilterToolbar bind:query={webhookQuery} placeholder={$t("Hooks.search")} clearLabel={$t("Common.clear_search")} />
  {/snippet}

  {#if showAdd}
    <div class="rounded-xl border bg-card p-5 space-y-4">
      <h3 class="text-sm font-semibold">{$t("Hooks.new_hook")}</h3>
      {#if addError}
        <div class="p-2 bg-red-500/10 text-red-600 text-xs rounded border border-red-500/20">{addError}</div>
      {/if}
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <span class="text-xs text-muted-foreground">{$t("Hooks.identifier_hint")}</span>
          <input type="text" bind:value={newName} placeholder={$t("Hooks.name_placeholder")}
            class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
        <div>
          <span class="text-xs text-muted-foreground">{$t("Hooks.table")}</span>
          <select bind:value={newTable} class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand">
            <option value="" disabled>{$t("Hooks.table_placeholder")}</option>
            {#each tables as tbl}
              <option value={tbl}>{tbl}</option>
            {/each}
          </select>
        </div>
        <div class="md:col-span-2">
          <span class="text-xs text-muted-foreground">{$t("Hooks.url")}</span>
          <input type="url" bind:value={newUrl} placeholder="https://your-server.com/webhook"
            class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
      </div>
      <div>
        <span class="text-xs text-muted-foreground">{$t("Hooks.events")}</span>
        <div class="flex flex-wrap gap-2 mt-1">
          {#each AVAILABLE_EVENTS as ev}
            <button
              onclick={() => {
                if (selectedEvents.includes(ev)) {
                  selectedEvents = selectedEvents.filter(e => e !== ev);
                } else {
                  selectedEvents = [...selectedEvents, ev];
                }
              }}
              class="px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors {selectedEvents.includes(ev) ? 'bg-brand text-white border-brand' : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'}"
            >
              {ev}
            </button>
          {/each}
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button onclick={() => showAdd = false} class="px-4 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">{$t("Hooks.cancel")}</button>
        <button onclick={saveWebhook} disabled={saveMutation.isPending} class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
          {#if saveMutation.isPending}<Loader2 size={12} class="animate-spin" />{/if} {$t("Hooks.save")}
        </button>
      </div>
    </div>
  {/if}

  {#if isLoading}
    <p class="text-xs font-mono uppercase tracking-widest text-muted-foreground">{$t("Hooks.loading")}</p>
  {:else if filteredEndpoints.length === 0}
    <DataState
      state={endpoints.length === 0 ? "empty" : "filtered-empty"}
      title={endpoints.length === 0 ? $t("Hooks.no_hooks_title") : $t("Common.no_matches")}
      description={endpoints.length === 0 ? $t("Hooks.no_hooks_description") : $t("Common.no_matches_hint")}
    />
  {:else}
    <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
      <div class="divide-y divide-border/20">
        {#each filteredEndpoints as endpoint (endpoint.id)}
          <div class="flex items-center justify-between px-5 py-4 hover:bg-muted/10 transition-colors">
            <div class="flex items-center gap-3">
              <Webhook size={16} class="text-brand" />
              <div>
                <span class="font-mono text-xs font-semibold">{endpoint.id} <span class="text-muted-foreground font-normal ml-2">{$t("Hooks.on_table", { values: { table: endpoint.table } })}</span></span>
                <div class="flex gap-1 mt-1">
                  {#each endpoint.events as ev}
                    <span class="px-1.5 py-0.5 rounded text-[8px] bg-brand/10 text-brand">{ev}</span>
                  {/each}
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              {#if endpoint.enabled}
                <span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-green-500/10 text-green-600">{$t("Hooks.enabled")}</span>
              {:else}
                <span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-muted text-muted-foreground">{$t("Hooks.disabled")}</span>
              {/if}
              <button onclick={() => deleteWebhook(endpoint.id)} disabled={deleteMutation.isPending} class="p-1 hover:bg-red-500/10 hover:text-red-500 rounded-md text-muted-foreground transition-colors disabled:opacity-50">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</PagePattern>
