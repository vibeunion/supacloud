<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, FunctionSquare, Search, Braces } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface DbFunction {
    function_name: string;
    schema_name: string;
    return_type: string;
    arguments: string;
    language: string;
    volatility: string;
    is_security_definer: boolean;
  }

  let searchQuery = $state("");
  let schemaFilter = $state("public");

  const projectRef = $derived(page.params.ref);

  const FUNCTIONS_SQL = `
    SELECT 
      p.proname as function_name,
      n.nspname as schema_name,
      pg_catalog.pg_get_function_result(p.oid) as return_type,
      pg_catalog.pg_get_function_arguments(p.oid) as arguments,
      l.lanname as language,
      CASE p.provolatile 
        WHEN 'i' THEN 'IMMUTABLE' 
        WHEN 's' THEN 'STABLE' 
        WHEN 'v' THEN 'VOLATILE' 
      END as volatility,
      p.prosecdef as is_security_definer
    FROM pg_catalog.pg_proc p
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname != 'information_schema'
      AND p.prokind = 'f'
    ORDER BY n.nspname, p.proname;
  `;

  const functionsQuery = createQuery(() => ({
    queryKey: ["database_functions", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: FUNCTIONS_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as DbFunction[];
    }
  }));

  const functions = $derived((functionsQuery.data as DbFunction[]) || []);
  const isLoading = $derived(functionsQuery.isPending);
  const error = $derived(functionsQuery.error?.message || null);
  const schemaOptions = $derived([...new Set(functions.map((fn) => fn.schema_name))].sort((a, b) => a.localeCompare(b)));

  const filteredFunctions = $derived(
    functions.filter((fn) => {
      const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
      const matchesSchema = schemaFilter === "all" || fn.schema_name === schemaFilter;
      if (!normalizedQuery) return matchesSchema;
      return matchesSchema && [fn.function_name, fn.arguments, fn.return_type, fn.language]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    })
  );

  const FUNCTION_LANGUAGE_KEYS: Record<string, string> = {
    plpgsql: "DbFunctions.language_plpgsql",
    sql: "DbFunctions.language_sql",
    plv8: "DbFunctions.language_plv8",
  };

  const FUNCTION_VOLATILITY_KEYS: Record<string, string> = {
    IMMUTABLE: "DbFunctions.volatility_immutable",
    STABLE: "DbFunctions.volatility_stable",
    VOLATILE: "DbFunctions.volatility_volatile",
  };

  const POSTGRES_TYPE_KEYS: Record<string, string> = {
    bigint: "DbFunctions.type_bigint",
    boolean: "DbFunctions.type_boolean",
    "double precision": "DbFunctions.type_double_precision",
    integer: "DbFunctions.type_integer",
    json: "DbFunctions.type_json",
    jsonb: "DbFunctions.type_jsonb",
    numeric: "DbFunctions.type_numeric",
    text: "DbFunctions.type_text",
    uuid: "DbFunctions.type_uuid",
    void: "DbFunctions.type_void",
    "timestamp with time zone": "DbFunctions.type_timestamptz",
  };

  function functionLanguageLabel(language: string): string {
    const key = FUNCTION_LANGUAGE_KEYS[language.toLowerCase()];
    return key ? $t(key) : language;
  }

  function functionVolatilityLabel(volatility: string): string {
    const key = FUNCTION_VOLATILITY_KEYS[volatility.toUpperCase()];
    return key ? $t(key) : volatility;
  }

  function postgresTypeLabel(type: string): string {
    const key = POSTGRES_TYPE_KEYS[type.trim().toLowerCase()];
    return key ? $t(key) : type;
  }

  function getLangColor(lang: string): string {
    if (lang === "plpgsql") return "text-blue-600 bg-blue-500/10";
    if (lang === "sql") return "text-green-600 bg-green-500/10";
    if (lang === "plv8" || lang === "plcoffee") return "text-amber-600 bg-amber-500/10";
    return "text-muted-foreground bg-muted/30";
  }

  function getVolColor(vol: string): string {
    if (vol === "IMMUTABLE") return "text-green-600 bg-green-500/10";
    if (vol === "STABLE") return "text-blue-600 bg-blue-500/10";
    return "text-amber-600 bg-amber-500/10";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("DbFunctions.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("DbFunctions.subtitle")}</p>
    </div>
    {#if !isLoading}
      <span class="px-2.5 py-1 rounded-full bg-brand/10 text-brand text-xs font-bold">{functions.length}</span>
    {/if}
  </div>

  <!-- Search -->
  <div class="relative w-64">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input
      bind:value={searchQuery}
      placeholder={$t("DbFunctions.search")}
      class="w-full pl-9 pr-3 py-1.5 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
    />
  </div>

  <div class="flex items-center gap-2">
    <label for="function-schema-filter" class="text-xs text-muted-foreground">{$t("DbFunctions.schema_filter")}</label>
    <select id="function-schema-filter" bind:value={schemaFilter} class="px-3 py-1.5 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand">
      <option value="all">{$t("DbFunctions.all_schemas")}</option>
      {#each schemaOptions as schemaName (schemaName)}
        <option value={schemaName}>{schemaName}</option>
      {/each}
    </select>
    <span class="text-[10px] text-muted-foreground">{$t("DbFunctions.default_schema_hint")}</span>
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("DbFunctions.loading")}</p>
      </div>
    {:else if error}
      <div class="p-4">
        <div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div>
      </div>
    {:else if filteredFunctions.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3 opacity-40">
        <Braces size={40} strokeWidth={1} />
        <p class="text-sm">{functions.length === 0 ? $t("DbFunctions.no_functions") : $t("DbFunctions.no_matching_functions")}</p>
      </div>
    {:else}
      <div class="overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("DbFunctions.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("DbFunctions.arguments")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("DbFunctions.return_type")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("DbFunctions.language")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("DbFunctions.volatility")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each filteredFunctions as fn}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <FunctionSquare size={13} class="text-brand/60" />
                    <span class="font-mono font-medium">{fn.function_name}</span>
                    {#if fn.is_security_definer}
                      <span title="DEFINER" class="px-1 py-0.5 rounded text-[9px] font-bold bg-red-500/10 text-red-500">{$t("DbFunctions.security_definer")}</span>
                    {/if}
                  </div>
                </td>
                <td class="px-3 py-2.5 font-mono text-[11px] text-muted-foreground max-w-xs truncate">
                  {fn.arguments || "()"}
                </td>
                <td class="px-3 py-2.5 font-mono text-[11px] text-muted-foreground" title={fn.return_type}>{postgresTypeLabel(fn.return_type)}</td>
                <td class="px-3 py-2.5">
                  <span title={fn.language} class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase {getLangColor(fn.language)}">{functionLanguageLabel(fn.language)}</span>
                </td>
                <td class="px-3 py-2.5">
                  <span title={fn.volatility} class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase {getVolColor(fn.volatility)}">{functionVolatilityLabel(fn.volatility)}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
