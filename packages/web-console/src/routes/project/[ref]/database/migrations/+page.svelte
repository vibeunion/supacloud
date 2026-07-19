<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, GitCommitVertical, FileCode2 } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

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
      if (!res.ok) throw new Error(data.message || data.error || "Failed to load migration history");
      return (Array.isArray(data) ? data : []) as Migration[];
    }
  }));

  const migrations = $derived((migrationsQuery.data as Migration[]) || []);
  const isLoading = $derived(migrationsQuery.isPending);
  const error = $derived(migrationsQuery.error?.message || null);
  const fallbackMsg = $derived(!isLoading && !error && migrations.length === 0 ? "暂无迁移历史" : null);

  function formatTime(ts: string | null): string {
    if (!ts) return "—";
    const timestamp = new Date(ts);
    return Number.isNaN(timestamp.getTime()) ? ts : timestamp.toLocaleString();
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("Migrations.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Migrations.subtitle")}</p>
    </div>
    {#if !isLoading && migrations.length > 0}
      <span class="px-2.5 py-1 rounded-full bg-brand/10 text-brand text-xs font-bold">{migrations.length}</span>
    {/if}
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("Migrations.loading")}</p>
      </div>
    {:else if error}
      <div class="p-4"><div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div></div>
    {:else if fallbackMsg}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-4 opacity-40">
        <FileCode2 size={48} strokeWidth={1} />
        <p class="text-sm">{fallbackMsg}</p>
      </div>
    {:else}
      <div class="overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Migrations.version")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Migrations.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-right">{$t("Migrations.statements")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">Checksum</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Migrations.applied_at")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each migrations as mig}
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
    {/if}
  </div>
</div>
