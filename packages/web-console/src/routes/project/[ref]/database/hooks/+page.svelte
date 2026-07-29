<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Webhook, Zap } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface DbHook {
    trigger_name: string;
    event_object_table: string;
    events: string;
    action_statement: string;
    is_enabled: string;
  }

  const projectRef = $derived(page.params.ref);

  const HOOKS_SQL = `
    SELECT 
      trigger_name,
      event_object_table,
      string_agg(DISTINCT event_manipulation, ', ') as events,
      action_statement,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_trigger t 
        JOIN pg_class c ON t.tgrelid = c.oid
        WHERE t.tgname = trg.trigger_name AND t.tgenabled = 'O'
      ) THEN 'YES' ELSE 'NO' END as is_enabled
    FROM information_schema.triggers trg
    WHERE action_statement LIKE '%net.http%' 
       OR action_statement LIKE '%supabase_functions%'
       OR trigger_name LIKE '%webhook%'
       OR trigger_name LIKE '%hook%'
    GROUP BY trigger_name, event_object_table, action_statement
    ORDER BY trigger_name;
  `;

  const hooksQuery = createQuery(() => ({
    queryKey: ["database_hooks", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: HOOKS_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as DbHook[];
    }
  }));

  const hooks = $derived((hooksQuery.data as DbHook[]) || []);
  const isLoading = $derived(hooksQuery.isPending);
  const error = $derived(hooksQuery.error?.message || null);
  const fallbackMsg = $derived(!isLoading && !error && hooks.length === 0 ? $t("Hooks.no_hooks") : null);

  function getEventColor(event: string): string {
    if (event.includes("INSERT")) return "text-green-600 bg-green-500/10";
    if (event.includes("UPDATE")) return "text-amber-600 bg-amber-500/10";
    if (event.includes("DELETE")) return "text-red-600 bg-red-500/10";
    return "text-blue-600 bg-blue-500/10";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">{$t("Hooks.title")}</h1>
    <p class="text-sm text-muted-foreground mt-1">{$t("Hooks.subtitle")}</p>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("Hooks.loading")}</p>
      </div>
    {:else if error}
      <div class="p-4"><div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div></div>
    {:else if fallbackMsg}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-4 opacity-40">
        <Webhook size={48} strokeWidth={1} />
        <p class="text-sm">{fallbackMsg}</p>
      </div>
    {:else}
      <div class="overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Hooks.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Hooks.table")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Hooks.events")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Hooks.function")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Hooks.enabled")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each hooks as hook}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <Zap size={13} class="text-amber-500" />
                    <span class="font-mono font-medium">{hook.trigger_name}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 font-mono text-muted-foreground">{hook.event_object_table}</td>
                <td class="px-3 py-2.5">
                  <div class="flex gap-1 flex-wrap">
                    {#each hook.events.split(", ") as event}
                      <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase {getEventColor(event)}">{event}</span>
                    {/each}
                  </div>
                </td>
                <td class="px-3 py-2.5 font-mono text-[11px] text-muted-foreground max-w-xs truncate">{hook.action_statement}</td>
                <td class="px-3 py-2.5 text-center">
                  {#if hook.is_enabled === "YES"}
                    <span class="px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 text-[10px] font-bold">{$t("Hooks.enabled")}</span>
                  {:else}
                    <span class="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px]">{$t("Hooks.disabled")}</span>
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
