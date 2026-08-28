<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, AlertTriangle, ShieldAlert, Info, CheckCircle2 } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface LintIssue {
    type: "no_primary_key" | "no_rls" | "no_index_on_fk" | "security_definer_no_search_path" | string;
    severity: "danger" | "warning" | "info";
    category: "security" | "performance" | "integrity";
    schema_name: string;
    object_name: string;
    detail: string;
    recommendation: string;
    fix_sql: string;
    column_name?: string | null;
    column_names?: string[];
    identity_args?: string | null;
  }

  const projectRef = $derived(page.params.ref);

  const lintQuery = createQuery(() => ({
    queryKey: ["database-lint", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/linter`, {
        method: "GET",
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.message || data.error || "Database linter query failed");
      return (data.issues || []) as LintIssue[];
    }
  }));

  const issues = $derived(lintQuery.data || []);
  const isLoading = $derived(lintQuery.isPending);
  const error = $derived(lintQuery.error ? (lintQuery.error instanceof Error ? lintQuery.error.message : String(lintQuery.error)) : null);

  function getSeverityColor(severity: string): string {
    if (severity === "danger") return "text-red-500 bg-red-500/10 border-red-500/20";
    if (severity === "warning") return "text-amber-500 bg-amber-500/10 border-amber-500/20";
    return "text-blue-500 bg-blue-500/10 border-blue-500/20";
  }

  function getTypeLabel(type: string): string {
    const key = `DatabaseLinter.${type}`;
    const translated = $t(key);
    return translated !== key ? translated : type;
  }

  function getTypeDesc(type: string): string {
    const key = `DatabaseLinter.${type}_desc`;
    const translated = $t(key);
    return translated !== key ? translated : "";
  }

  function getSeverityLabel(severity: string): string {
    if (severity === "danger") return $t("DatabaseLinter.severity_danger");
    if (severity === "warning") return $t("DatabaseLinter.severity_warning");
    return $t("DatabaseLinter.severity_info");
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center gap-3">
    <h1 class="text-2xl font-bold">{$t("DatabaseLinter.title")}</h1>
    {#if !isLoading && issues.length > 0}
      <span class="px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 text-xs font-bold">{issues.length} {$t("DatabaseLinter.issues_found")}</span>
    {/if}
  </div>
  <p class="text-sm text-muted-foreground">{$t("DatabaseLinter.subtitle")}</p>

  <div class="flex-1 overflow-y-auto space-y-3">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("DatabaseLinter.loading")}</p>
      </div>
    {:else if error}
      <div class="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm font-mono">
        {error}
      </div>
    {:else if issues.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-4">
        <div class="w-16 h-16 rounded-full bg-green-500/10 text-green-500 flex items-center justify-center">
          <CheckCircle2 size={32} />
        </div>
        <p class="text-sm font-medium">{$t("DatabaseLinter.no_issues")}</p>
      </div>
    {:else}
      {#each issues as issue (`${issue.type}-${issue.schema_name}-${issue.object_name}-${issue.column_name || issue.column_names?.join(",") || issue.identity_args || ""}`)}
        <div class="rounded-lg border {getSeverityColor(issue.severity)} p-4 transition-all hover:shadow-sm">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-start gap-3 flex-1">
              <div class="mt-0.5">
                {#if issue.severity === "danger"}
                  <ShieldAlert size={18} />
                {:else if issue.severity === "warning"}
                  <AlertTriangle size={18} />
                {:else}
                  <Info size={18} />
                {/if}
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="font-semibold text-sm">{getTypeLabel(issue.type)}</span>
                  <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded {getSeverityColor(issue.severity)}">{getSeverityLabel(issue.severity)}</span>
                </div>
                <p class="text-xs text-muted-foreground mb-2">{getTypeDesc(issue.type) || issue.detail}</p>
                <div class="flex items-center gap-2 text-xs">
                  <span class="font-medium">{$t("DatabaseLinter.table")}:</span>
                  <code class="px-1.5 py-0.5 bg-muted/50 rounded font-mono text-[11px]">{issue.schema_name}.{issue.object_name}{issue.identity_args ? `(${issue.identity_args})` : ""}</code>
                </div>
              </div>
            </div>
          </div>
          {#if issue.fix_sql}
            <div class="mt-3 pt-3 border-t border-current/10">
              <p class="text-[10px] font-bold uppercase tracking-wider mb-1.5 opacity-70">{$t("DatabaseLinter.fix_hint")}</p>
              <code class="block text-[11px] font-mono p-2 rounded bg-background/50 overflow-x-auto whitespace-pre">{issue.fix_sql}</code>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>
