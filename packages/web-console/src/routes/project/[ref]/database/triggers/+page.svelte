<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Zap, ZapOff } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

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

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">{$t("Triggers.title")}</h1>
    <p class="text-sm text-muted-foreground mt-1">{$t("Triggers.subtitle")}</p>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("Triggers.loading")}</p>
      </div>
    {:else if error}
      <div class="p-4">
        <div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div>
      </div>
    {:else if triggers.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3 opacity-40">
        <ZapOff size={40} strokeWidth={1} />
        <p class="text-sm">{$t("Triggers.no_triggers")}</p>
      </div>
    {:else}
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
            {#each triggers as trg}
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
    {/if}
  </div>
</div>
