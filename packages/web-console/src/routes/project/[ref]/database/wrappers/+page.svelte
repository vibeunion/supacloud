<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, Globe, Plus, X } from "lucide-svelte";
  import { t } from "svelte-i18n";
  import { toast } from "svelte-sonner";
  import { createQuery } from "@tanstack/svelte-query";

  interface Wrapper {
    id: number;
    name: string;
    handler: string;
    validator: string;
    server: string;
    fdw_type: string;
  }

  const projectRef = $derived(page.params.ref);

  const WRAPPERS_SQL = `
    SELECT 
      f.oid::int as id,
      f.fdwname as name,
      f.fdwhandler::regproc::text as handler,
      f.fdwvalidator::regproc::text as validator,
      s.srvname as server,
      CASE 
        WHEN f.fdwname ILIKE '%postgres%' THEN 'PostgreSQL'
        WHEN f.fdwname ILIKE '%stripe%' THEN 'Stripe'
        WHEN f.fdwname ILIKE '%firebase%' THEN 'Firebase'
        WHEN f.fdwname ILIKE '%s3%' THEN 'S3'
        WHEN f.fdwname ILIKE '%clickhouse%' THEN 'ClickHouse'
        WHEN f.fdwname ILIKE '%bigquery%' THEN 'BigQuery'
        WHEN f.fdwname ILIKE '%mongodb%' THEN 'MongoDB'
        ELSE 'Custom'
      END as fdw_type
    FROM pg_foreign_data_wrapper f
    LEFT JOIN pg_foreign_server s ON s.srvfdw = f.oid
    ORDER BY f.fdwname;
  `;

  const wrappersQuery = createQuery(() => ({
    queryKey: ["database_wrappers", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: WRAPPERS_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as Wrapper[];
    }
  }));

  const wrappers = $derived((wrappersQuery.data as Wrapper[]) || []);
  const isLoading = $derived(wrappersQuery.isPending);
  let showCreate = $state(false);
  let wrapperType = $state<"stripe" | "mongodb">("stripe");
  let serverName = $state("stripe_server");
  let schemaName = $state("stripe");
  let credential = $state("");
  let apiVersion = $state("");
  let saving = $state(false);

  function selectType(type: "stripe" | "mongodb") {
    wrapperType = type;
    serverName = type === "stripe" ? "stripe_server" : "mongodb_server";
    schemaName = type === "stripe" ? "stripe" : "mongo";
  }

  async function createWrapper() {
    saving = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/database/wrappers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: wrapperType,
          server_name: serverName,
          schema_name: schemaName,
          credential,
          ...(wrapperType === "stripe" && apiVersion ? { api_version: apiVersion } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || $t("Wrappers.configure_failed"));
      credential = "";
      showCreate = false;
      await wrappersQuery.refetch();
      toast.success($t(wrapperType === "stripe" ? "Wrappers.stripe_configured" : "Wrappers.mongodb_configured"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : $t("Wrappers.configure_failed"));
    } finally {
      saving = false;
    }
  }

  function getTypeIcon(type: string): string {
    if (type === "PostgreSQL") return "🐘";
    if (type === "Stripe") return "💳";
    if (type === "Firebase") return "🔥";
    if (type === "S3") return "📦";
    if (type === "ClickHouse") return "🏠";
    if (type === "BigQuery") return "📊";
    if (type === "MongoDB") return "🍃";
    return "🔗";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 class="text-2xl font-bold">{$t("Wrappers.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Wrappers.subtitle")}</p>
    </div>
    <button onclick={() => showCreate = !showCreate} class="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white">{#if showCreate}<X size={15} />{$t("Wrappers.cancel")}{:else}<Plus size={15} />{$t("Wrappers.configure")}{/if}</button>
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Globe size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">{$t("Wrappers.description")}</p>
  </div>

  {#if showCreate}
    <section class="space-y-4 rounded-xl border bg-card p-5">
      <div class="flex gap-2">
        <button onclick={() => selectType("stripe")} class={`rounded-md border px-3 py-2 text-sm ${wrapperType === "stripe" ? "border-brand bg-brand/10 text-brand" : ""}`}>{$t("Wrappers.stripe_sync")}</button>
        <button onclick={() => selectType("mongodb")} class={`rounded-md border px-3 py-2 text-sm ${wrapperType === "mongodb" ? "border-brand bg-brand/10 text-brand" : ""}`}>{$t("Wrappers.mongodb")}</button>
      </div>
      <div class="grid gap-3 md:grid-cols-2">
        <label class="space-y-1 text-xs"><span>{$t("Wrappers.server_name")}</span><input bind:value={serverName} class="h-9 w-full rounded-md border bg-background px-3 font-mono" /></label>
        <label class="space-y-1 text-xs"><span>{$t("Wrappers.schema")}</span><input bind:value={schemaName} class="h-9 w-full rounded-md border bg-background px-3 font-mono" /></label>
        {#if wrapperType === "stripe"}<label class="space-y-1 text-xs"><span>{$t("Wrappers.stripe_api_version")}</span><input bind:value={apiVersion} class="h-9 w-full rounded-md border bg-background px-3 font-mono" placeholder="2024-06-20" /></label>{/if}
      </div>
      <label class="block space-y-1 text-xs"><span>{wrapperType === "stripe" ? $t("Wrappers.stripe_credential") : $t("Wrappers.mongodb_credential")}</span><input bind:value={credential} type="password" class="h-9 w-full rounded-md border bg-background px-3 font-mono" autocomplete="off" /></label>
      <div class="flex items-center justify-between gap-3"><p class="text-xs text-muted-foreground">{$t("Wrappers.vault_notice")}</p><button onclick={createWrapper} disabled={saving || !credential || !serverName || !schemaName} class="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white disabled:opacity-50">{#if saving}<Loader2 size={15} class="animate-spin" />{/if}{$t("Wrappers.create")}</button></div>
    </section>
  {/if}

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("Wrappers.loading")}</p>
      </div>
    {:else if wrappers.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Globe size={40} class="opacity-20" />
        <p class="text-sm">{$t("Wrappers.empty")}</p>
        <p class="text-xs">{$t("Wrappers.empty_description")}</p>
      </div>
    {:else}
      <div class="overflow-auto">
        <div class="divide-y divide-border/20">
          {#each wrappers as wrapper (`${wrapper.id}:${wrapper.server}`)}
            <div class="flex items-center justify-between px-5 py-4 hover:bg-muted/10 transition-colors">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-lg bg-brand/10 text-brand flex items-center justify-center text-lg">
                  {getTypeIcon(wrapper.fdw_type)}
                </div>
                <div>
                  <span class="font-semibold text-sm">{wrapper.name}</span>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase text-blue-600 bg-blue-500/10">{wrapper.fdw_type}</span>
                    {#if wrapper.server}
                      <span class="text-[10px] text-muted-foreground">→ {wrapper.server}</span>
                    {/if}
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-3 text-xs text-muted-foreground font-mono">
                <span>{wrapper.handler}</span>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
