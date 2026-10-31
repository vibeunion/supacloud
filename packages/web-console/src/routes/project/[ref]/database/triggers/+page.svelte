<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Zap } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import PagePattern from "@svadmin/ui/components/PagePattern.svelte";
  import FilterToolbar from "@svadmin/ui/components/content/FilterToolbar.svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";

  interface Trigger {
    trigger_name: string;
    event_manipulation: string;
    event_object_table: string;
    action_timing: string;
    action_statement: string;
    is_enabled: string;
  }

  const projectRef = $derived(page.params.ref);

  const TRIGGERS_SQL = `
    SELECT 
      trigger_name,
      event_manipulation,
      event_object_table,
      action_timing,
      action_statement,
      CASE 
        WHEN EXISTS (
          SELECT 1 FROM pg_trigger t 
          JOIN pg_class c ON t.tgrelid = c.oid 
          JOIN pg_namespace n ON c.relnamespace = n.oid 
          WHERE t.tgname = trg.trigger_name 
            AND c.relname = trg.event_object_table 
            AND n.nspname = 'public' 
            AND t.tgenabled = 'O'
        ) THEN 'YES' ELSE 'NO' 
      END as is_enabled
    FROM information_schema.triggers trg
    WHERE trigger_schema = 'public'
    ORDER BY event_object_table, trigger_name;
  `;

  const triggersQuery = createQuery(() => ({
    queryKey: ["database_triggers", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: TRIGGERS_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as Trigger[];
    }
  }));

  const triggers = $derived((triggersQuery.data as Trigger[]) || []);
  const isLoading = $derived(triggersQuery.isPending);
  const error = $derived(triggersQuery.error?.message || null);
  let triggerQuery = $state("");
  const normalizedTriggerQuery = $derived(triggerQuery.trim().toLocaleLowerCase());
  const filteredTriggers = $derived(
    normalizedTriggerQuery
      ? triggers.filter((trigger) =>
          [trigger.trigger_name, trigger.event_object_table, trigger.event_manipulation, trigger.action_statement]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedTriggerQuery),
        )
      : triggers,
  );
  const pageState = $derived.by(() => {
    if (isLoading) return "loading" as const;
    if (error) return "error" as const;
    if (triggers.length === 0) return "empty" as const;
    return "ready" as const;
  });

  const TRIGGER_EVENT_KEYS: Record<string, string> = {
    INSERT: "Triggers.event_insert",
    UPDATE: "Triggers.event_update",
    DELETE: "Triggers.event_delete",
  };

  const TRIGGER_TIMING_KEYS: Record<string, string> = {
    BEFORE: "Triggers.timing_before",
    AFTER: "Triggers.timing_after",
    "INSTEAD OF": "Triggers.timing_instead_of",
  };

  function triggerEventLabel(event: string): string {
    const key = TRIGGER_EVENT_KEYS[event.toUpperCase()];
    return key ? $t(key) : event;
  }

  function triggerTimingLabel(timing: string): string {
    const key = TRIGGER_TIMING_KEYS[timing.toUpperCase()];
    return key ? $t(key) : timing;
  }

  function getEventColor(event: string): string {
    if (event === "INSERT") return "text-green-600 bg-green-500/10";
    if (event === "UPDATE") return "text-amber-600 bg-amber-500/10";
    if (event === "DELETE") return "text-red-600 bg-red-500/10";
    return "text-blue-600 bg-blue-500/10";
  }

  function extractFuncName(stmt: string): string {
    const match = stmt.match(/EXECUTE (?:FUNCTION|PROCEDURE)\s+(.+?)(?:\(|$)/i);
    return match ? match[1].trim() : stmt;
  }
</script>

<PagePattern
  kind="list"
  pageId="database-triggers"
  title={$t("Triggers.title")}
  description={$t("Triggers.subtitle")}
  state={pageState}
  stateTitle={pageState === "error" ? (error || $t("Common.error")) : pageState === "empty" ? $t("Triggers.no_triggers") : $t("Triggers.loading")}
  stateDescription={pageState === "error" ? error || undefined : undefined}
  retry={() => { void triggersQuery.refetch(); }}
  class="h-full"
>
  {#snippet toolbar()}
    <FilterToolbar bind:query={triggerQuery} placeholder={$t("Triggers.search")} clearLabel={$t("Common.clear_search")} />
  {/snippet}

  {#if filteredTriggers.length === 0}
    <DataState state="filtered-empty" title={$t("Common.no_matches")} description={$t("Common.no_matches_hint")} />
  {:else}
    <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
      <div class="overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Triggers.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Triggers.table")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Triggers.event")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Triggers.timing")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Triggers.function")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Triggers.status")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each filteredTriggers as trg (`${trg.event_object_table}:${trg.trigger_name}:${trg.event_manipulation}`)}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <Zap size={13} class="text-amber-500" />
                    <span class="font-mono font-medium">{trg.trigger_name}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 font-mono text-muted-foreground">{trg.event_object_table}</td>
                <td class="px-3 py-2.5">
                  <span title={trg.event_manipulation} class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase {getEventColor(trg.event_manipulation)}">
                    {triggerEventLabel(trg.event_manipulation)}
                  </span>
                </td>
                <td title={trg.action_timing} class="px-3 py-2.5 text-muted-foreground uppercase text-[10px] font-bold tracking-wider">{triggerTimingLabel(trg.action_timing)}</td>
                <td class="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">{extractFuncName(trg.action_statement)}</td>
                <td class="px-3 py-2.5 text-center">
                  {#if trg.is_enabled === "YES"}
                    <span title={trg.is_enabled} class="px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 text-[10px] font-bold">{$t("Triggers.enabled")}</span>
                  {:else}
                    <span title={trg.is_enabled} class="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px]">{$t("Triggers.disabled")}</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</PagePattern>
