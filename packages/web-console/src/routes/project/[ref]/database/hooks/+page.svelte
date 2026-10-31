<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Zap } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import PagePattern from "@svadmin/ui/components/PagePattern.svelte";
  import FilterToolbar from "@svadmin/ui/components/content/FilterToolbar.svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";

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
  let hookQuery = $state("");
  const normalizedHookQuery = $derived(hookQuery.trim().toLocaleLowerCase());
  const filteredHooks = $derived(
    normalizedHookQuery
      ? hooks.filter((hook) =>
          [hook.trigger_name, hook.event_object_table, hook.events, hook.action_statement]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedHookQuery),
        )
      : hooks,
  );
  const pageState = $derived.by(() => {
    if (isLoading) return "loading" as const;
    if (error) return "error" as const;
    if (hooks.length === 0) return "empty" as const;
    return "ready" as const;
  });

  function getEventColor(event: string): string {
    if (event.includes("INSERT")) return "text-green-600 bg-green-500/10";
    if (event.includes("UPDATE")) return "text-amber-600 bg-amber-500/10";
    if (event.includes("DELETE")) return "text-red-600 bg-red-500/10";
    return "text-blue-600 bg-blue-500/10";
  }
</script>

<PagePattern
  kind="list"
  pageId="database-hooks"
  title={$t("Hooks.title")}
  description={$t("Hooks.subtitle")}
  state={pageState}
  stateTitle={pageState === "error" ? (error || $t("Common.error")) : pageState === "empty" ? $t("Hooks.no_hooks") : $t("Hooks.loading")}
  stateDescription={pageState === "error" ? error || undefined : undefined}
  retry={() => { void hooksQuery.refetch(); }}
  class="h-full"
>
  {#snippet toolbar()}
    <FilterToolbar bind:query={hookQuery} placeholder={$t("Hooks.search")} clearLabel={$t("Common.clear_search")} />
  {/snippet}

  {#if filteredHooks.length === 0}
    <DataState state="filtered-empty" title={$t("Common.no_matches")} description={$t("Common.no_matches_hint")} />
  {:else}
    <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
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
            {#each filteredHooks as hook (hook.trigger_name)}
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
    </div>
  {/if}
</PagePattern>
