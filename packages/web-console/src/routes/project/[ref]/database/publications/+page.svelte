<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Radio, Check, X } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import PagePattern from "@svadmin/ui/components/PagePattern.svelte";
  import FilterToolbar from "@svadmin/ui/components/content/FilterToolbar.svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";

  interface Publication {
    pubname: string;
    pubowner: string;
    puballtables: boolean;
    pubinsert: boolean;
    pubupdate: boolean;
    pubdelete: boolean;
    pubtruncate: boolean;
    tables: string;
  }

  const projectRef = $derived(page.params.ref);

  const PUB_SQL = `
    SELECT 
      p.pubname,
      pg_catalog.pg_get_userbyid(p.pubowner) as pubowner,
      p.puballtables,
      p.pubinsert,
      p.pubupdate,
      p.pubdelete,
      p.pubtruncate,
      COALESCE(string_agg(c.relname, ', '), '') as tables
    FROM pg_publication p
    LEFT JOIN pg_publication_rel pr ON p.oid = pr.prpubid
    LEFT JOIN pg_class c ON pr.prrelid = c.oid
    GROUP BY p.pubname, p.pubowner, p.puballtables, p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate
    ORDER BY p.pubname;
  `;

  const publicationsQuery = createQuery(() => ({
    queryKey: ["database_publications", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: PUB_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as Publication[];
    }
  }));

  const publications = $derived((publicationsQuery.data as Publication[]) || []);
  const isLoading = $derived(publicationsQuery.isPending);
  const error = $derived(publicationsQuery.error?.message || null);
  let publicationQuery = $state("");
  const normalizedPublicationQuery = $derived(publicationQuery.trim().toLocaleLowerCase());
  const filteredPublications = $derived(
    normalizedPublicationQuery
      ? publications.filter((publication) =>
          [publication.pubname, publication.pubowner, publication.tables]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedPublicationQuery),
        )
      : publications,
  );
  const pageState = $derived.by(() => {
    if (isLoading) return "loading" as const;
    if (error) return "error" as const;
    if (publications.length === 0) return "empty" as const;
    return "ready" as const;
  });
</script>

<PagePattern
  kind="list"
  pageId="database-publications"
  title={$t("Publications.title")}
  description={$t("Publications.subtitle")}
  state={pageState}
  stateTitle={pageState === "error" ? (error || $t("Common.error")) : pageState === "empty" ? $t("Publications.no_publications") : $t("Publications.loading")}
  stateDescription={pageState === "error" ? error || undefined : undefined}
  retry={() => { void publicationsQuery.refetch(); }}
  class="h-full"
>
  {#snippet toolbar()}
    <FilterToolbar bind:query={publicationQuery} placeholder={$t("Publications.search")} clearLabel={$t("Common.clear_search")} />
  {/snippet}

  {#if filteredPublications.length === 0}
    <DataState state="filtered-empty" title={$t("Common.no_matches")} description={$t("Common.no_matches_hint")} />
  {:else}
    <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
      <div class="overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Publications.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Publications.owner")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Publications.all_tables")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Publications.insert")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Publications.update")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Publications.delete")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Publications.truncate")}</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Publications.tables")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each filteredPublications as pub (pub.pubname)}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <Radio size={13} class="text-brand" />
                    <span class="font-mono font-medium">{pub.pubname}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 text-muted-foreground">{pub.pubowner}</td>
                <td class="px-3 py-2.5 text-center">
                  {#if pub.puballtables}<Check size={13} class="inline text-green-500" />{:else}<X size={13} class="inline text-muted-foreground/30" />{/if}
                </td>
                <td class="px-3 py-2.5 text-center">
                  {#if pub.pubinsert}<Check size={13} class="inline text-green-500" />{:else}<X size={13} class="inline text-muted-foreground/30" />{/if}
                </td>
                <td class="px-3 py-2.5 text-center">
                  {#if pub.pubupdate}<Check size={13} class="inline text-green-500" />{:else}<X size={13} class="inline text-muted-foreground/30" />{/if}
                </td>
                <td class="px-3 py-2.5 text-center">
                  {#if pub.pubdelete}<Check size={13} class="inline text-green-500" />{:else}<X size={13} class="inline text-muted-foreground/30" />{/if}
                </td>
                <td class="px-3 py-2.5 text-center">
                  {#if pub.pubtruncate}<Check size={13} class="inline text-green-500" />{:else}<X size={13} class="inline text-muted-foreground/30" />{/if}
                </td>
                <td class="px-4 py-2.5 font-mono text-[11px] text-muted-foreground max-w-xs truncate">
                  {pub.puballtables ? $t("Publications.all_tables_value") : (pub.tables || "—")}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</PagePattern>
