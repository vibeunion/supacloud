<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { GitCommitVertical } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import PagePattern from "@svadmin/ui/components/PagePattern.svelte";
  import FilterToolbar from "@svadmin/ui/components/content/FilterToolbar.svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";

  interface Migration {
    version: string;
    name: string | null;
    statements: string[];
    statement_count: number;
    checksum: string;
    applied_at: string | null;
  }

  const projectRef = $derived(page.params.ref);

  const migrationsQuery = createQuery(() => ({
    queryKey: ["database_migrations", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/migrations`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || $t("Migrations.load_failed"));
      return (Array.isArray(data) ? data : []).map((row: Record<string, unknown>): Migration => {
        const statements = Array.isArray(row.statements)
          ? row.statements.filter((statement): statement is string => typeof statement === "string")
          : [];
        const statementCount = typeof row.statement_count === "number" && Number.isFinite(row.statement_count)
          ? row.statement_count
          : statements.length;

        return {
          version: String(row.version || ""),
          name: typeof row.name === "string" ? row.name : null,
          statements,
          statement_count: statementCount,
          checksum: typeof row.checksum === "string" ? row.checksum : "",
          applied_at: typeof row.applied_at === "string" ? row.applied_at : null,
        };
      });
    }
  }));

  const migrations = $derived(migrationsQuery.data || []);
  const isLoading = $derived(migrationsQuery.isPending);
  const error = $derived(migrationsQuery.error?.message || null);
  let migrationQuery = $state("");
  const normalizedMigrationQuery = $derived(migrationQuery.trim().toLocaleLowerCase());
  const filteredMigrations = $derived(
    normalizedMigrationQuery
      ? migrations.filter((migration) =>
          [migration.version, migration.name || "", migration.checksum]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedMigrationQuery),
        )
      : migrations,
  );
  const pageState = $derived.by(() => {
    if (isLoading) return "loading" as const;
    if (error) return "error" as const;
    if (migrations.length === 0) return "empty" as const;
    return "ready" as const;
  });

  function formatTime(ts: string | null): string {
    if (!ts) return "—";
    const timestamp = new Date(ts);
    return Number.isNaN(timestamp.getTime()) ? ts : timestamp.toLocaleString();
  }
</script>

<PagePattern
  kind="list"
  pageId="database-migrations"
  title={$t("Migrations.title")}
  description={`${$t("Migrations.subtitle")} ${$t("Migrations.technical_names_note")}`}
  state={pageState}
  stateTitle={pageState === "error" ? $t("Migrations.load_failed") : pageState === "empty" ? $t("Migrations.empty") : $t("Migrations.loading")}
  stateDescription={pageState === "error" ? error || undefined : pageState === "empty" ? $t("Migrations.no_migrations") : undefined}
  retry={() => { void migrationsQuery.refetch(); }}
  class="h-full"
>
  {#snippet actions()}
    {#if !isLoading && migrations.length > 0}
      <span class="px-2.5 py-1 rounded-full bg-brand/10 text-brand text-xs font-bold">{filteredMigrations.length}</span>
    {/if}
  {/snippet}
  {#snippet toolbar()}
    <FilterToolbar bind:query={migrationQuery} placeholder={$t("Migrations.search")} clearLabel={$t("Common.clear_search")} />
  {/snippet}

  {#if filteredMigrations.length === 0}
    <DataState state="filtered-empty" title={$t("Common.no_matches")} description={$t("Common.no_matches_hint")} />
  {:else}
    <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
      <div class="overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Migrations.version")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Migrations.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-right">{$t("Migrations.statements")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Migrations.checksum")}</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Migrations.applied_at")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each filteredMigrations as mig (mig.version)}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <GitCommitVertical size={13} class="text-brand" />
                    <span class="font-mono font-bold text-[11px]">{mig.version}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 text-muted-foreground">{mig.name || "—"}</td>
                <td class="px-3 py-2.5 text-right">
                  <span class="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-bold tabular-nums">{mig.statement_count}</span>
                </td>
                <td class="px-3 py-2.5 text-muted-foreground" title={mig.checksum}>
                  <span class="font-mono text-[10px]">{mig.checksum.slice(0, 12)}</span>
                </td>
                <td class="px-4 py-2.5 text-muted-foreground text-[11px]">{formatTime(mig.applied_at)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</PagePattern>
