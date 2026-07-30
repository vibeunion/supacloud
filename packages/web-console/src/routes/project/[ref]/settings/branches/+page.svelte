<script lang="ts">
  import { page } from "$app/state";
  import {
    AlertCircle,
    ArrowUpCircle,
    CheckCircle2,
    Clock,
    Database,
    GitBranch,
    Loader2,
    Plus,
    ShieldCheck,
    Trash2,
    TriangleAlert,
    XCircle,
  } from "lucide-svelte";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  type BranchDataMode = "schema_only" | "full_clone";

  interface Branch {
    ref: string;
    name: string;
    parent_ref: string;
    status: "creating" | "active" | "deleting" | "error";
    created_at: string;
    data_mode?: BranchDataMode;
    error?: string;
  }

  interface PromotionEntry {
    version: string;
    name: string | null;
    checksum: string;
    statement_count: number;
    statements?: string[];
    destructive: boolean;
  }

  interface PromotionBlock {
    code: string;
    version: string;
    name: string | null;
    message: string;
  }

  interface PromotionPlan {
    mode: "migrations";
    parent_ref: string;
    branch_ref: string;
    safe_to_apply: boolean;
    plan_checksum: string;
    pending: PromotionEntry[];
    applied: PromotionEntry[];
    blocked: PromotionBlock[];
    warnings: string[];
    requires_destructive_confirmation: boolean;
    ignored_branch_data: true;
  }

  interface PromotionResult {
    applied: PromotionEntry[];
    plan: PromotionPlan;
  }

  interface ReplacementResult {
    backup_database: string;
  }

  class ApiOperationError extends Error {
    payload: Record<string, unknown>;

    constructor(message: string, payload: Record<string, unknown>) {
      super(message);
      this.name = "ApiOperationError";
      this.payload = payload;
    }
  }

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  let showCreate = $state(false);
  let branchName = $state("");
  let dataMode = $state<BranchDataMode>("schema_only");
  let msg = $state<string | null>(null);
  let errMsg = $state<string | null>(null);
  let promoteTarget = $state<Branch | null>(null);
  let promotionPlan = $state<PromotionPlan | null>(null);
  let promotionError = $state<string | null>(null);
  let promotionNeedsRefresh = $state(false);
  let confirmDestructive = $state(false);
  let replaceTarget = $state<Branch | null>(null);
  let replaceConfirmation = $state("");
  let replaceError = $state<string | null>(null);
  let replacementRecoveryRequired = $state(false);
  const replaceExpected = $derived(replaceTarget ? `REPLACE ${projectRef} WITH ${replaceTarget.ref}` : "");

  function operationError(data: unknown, fallback: string): ApiOperationError {
    const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const lines = [typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : fallback];
    if (Array.isArray(payload.applied) && payload.applied.length > 0) {
      const versions = payload.applied
        .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).version : null)
        .filter((version): version is string => typeof version === "string");
      lines.push($t("Branches.applied_before_failure", { values: { versions: versions.join(", ") || payload.applied.length } }));
    }
    if (payload.recovery_required === true) {
      const recoveryDatabase = typeof payload.recovery_database === "string" ? payload.recovery_database : null;
      const recoveryTarget = recoveryDatabase || (typeof payload.backup_database === "string" ? payload.backup_database : null);
      lines.push(recoveryTarget
        ? $t("Branches.manual_recovery_with_database", { values: { database: recoveryTarget } })
        : $t("Branches.manual_recovery"));
    }
    return new ApiOperationError(lines.join(" "), payload);
  }

  const branchesQuery = createQuery(() => ({
    queryKey: ["branches", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/branches`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || $t("Branches.load_failed"));
      return (data.branches || []) as Branch[];
    },
    refetchInterval: 5000,
  }));

  const branches = $derived((branchesQuery.data as Branch[]) || []);
  const isLoading = $derived(branchesQuery.isPending);
  const loadError = $derived(branchesQuery.error?.message || null);

  const createBranchMut = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/branches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: branchName.trim(), data_mode: dataMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || $t("Branches.create_failed"));
      return data;
    },
    onSuccess: () => {
      showCreate = false;
      branchName = "";
      dataMode = "schema_only";
      msg = $t("Branches.created");
      setTimeout(() => (msg = null), 4000);
      queryClient.invalidateQueries({ queryKey: ["branches", projectRef] });
    },
    onError: (err: unknown) => {
      errMsg = err instanceof Error ? err.message : String(err);
    },
  }));

  const deleteBranchMut = createMutation(() => ({
    mutationFn: async (branchRef: string) => {
      const res = await apiClient(`/v1/projects/${projectRef}/branches/${branchRef}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || $t("Branches.delete_failed"));
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branches", projectRef] });
    },
  }));

  const promotionPlanMut = createMutation(() => ({
    mutationFn: async (branchRef: string): Promise<PromotionPlan> => {
      const res = await apiClient(`/v1/projects/${projectRef}/branches/${branchRef}/promote/plan`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || $t("Branches.plan_failed"));
      return data as PromotionPlan;
    },
    onSuccess: (plan) => {
      promotionPlan = plan;
      promotionError = null;
      promotionNeedsRefresh = false;
    },
    onError: (err: unknown) => {
      promotionError = err instanceof Error ? err.message : String(err);
    },
  }));

  const promoteBranchMut = createMutation(() => ({
    mutationFn: async (input: { branchRef: string; plan: PromotionPlan }): Promise<PromotionResult> => {
      const res = await apiClient(`/v1/projects/${projectRef}/branches/${input.branchRef}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "migrations",
          plan_checksum: input.plan.plan_checksum,
          confirm_destructive: confirmDestructive,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw operationError(data, $t("Branches.promote_failed"));
      return data as PromotionResult;
    },
    onSuccess: (result) => {
      const appliedCount = result.applied?.length || 0;
      closePromotion();
      msg = appliedCount > 0
        ? $t("Branches.promoted", { values: { count: appliedCount } })
        : $t("Branches.up_to_date");
      setTimeout(() => (msg = null), 5000);
      queryClient.invalidateQueries({ queryKey: ["branches", projectRef] });
      queryClient.invalidateQueries({ queryKey: ["database_migrations", projectRef] });
    },
    onError: (err: unknown) => {
      promotionError = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiOperationError) {
        const plan = err.payload.plan;
        if (plan && typeof plan === "object") promotionPlan = plan as PromotionPlan;
        if (Array.isArray(err.payload.applied) && err.payload.applied.length > 0) {
          promotionNeedsRefresh = true;
          queryClient.invalidateQueries({ queryKey: ["database_migrations", projectRef] });
        }
        if (err.payload.code === "promotion_plan_changed" || err.payload.code === "promotion_readback_failed") {
          promotionNeedsRefresh = true;
        }
      }
    },
  }));

  const replaceDatabaseMut = createMutation(() => ({
    mutationFn: async (branchRef: string): Promise<ReplacementResult> => {
      const res = await apiClient(`/v1/projects/${projectRef}/branches/${branchRef}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "replace_database", confirmation: replaceConfirmation }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw operationError(data, $t("Branches.replace_failed"));
      if (!data || typeof data !== "object" || typeof (data as Record<string, unknown>).backup_database !== "string") {
        throw operationError({
          ...(data && typeof data === "object" ? data as Record<string, unknown> : {}),
          error: $t("Branches.backup_evidence_missing"),
          replacement_committed: true,
          recovery_required: true,
        }, $t("Branches.replace_backup_missing"));
      }
      return data as ReplacementResult;
    },
    onSuccess: (result) => {
      replaceTarget = null;
      replaceConfirmation = "";
      replacementRecoveryRequired = false;
      msg = $t("Branches.replaced", { values: { database: result.backup_database } });
      setTimeout(() => (msg = null), 6000);
      queryClient.invalidateQueries({ queryKey: ["branches", projectRef] });
    },
    onError: (err: unknown) => {
      replaceError = err instanceof Error ? err.message : String(err);
      replacementRecoveryRequired = err instanceof ApiOperationError && err.payload.recovery_required === true;
    },
  }));

  function handleCreate() {
    errMsg = null;
    if (!branchName.trim()) {
      errMsg = $t("Branches.name_required");
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(branchName.trim())) {
      errMsg = $t("Branches.name_invalid");
      return;
    }
    createBranchMut.mutate();
  }

  function openPromotion(branch: Branch) {
    errMsg = null;
    promoteTarget = branch;
    promotionPlan = null;
    promotionError = null;
    promotionNeedsRefresh = false;
    confirmDestructive = false;
    promotionPlanMut.mutate(branch.ref);
  }

  function closePromotion() {
    promoteTarget = null;
    promotionPlan = null;
    promotionError = null;
    promotionNeedsRefresh = false;
    confirmDestructive = false;
  }

  function openReplacement(branch: Branch) {
    closePromotion();
    replaceTarget = branch;
    replaceConfirmation = "";
    replaceError = null;
    replacementRecoveryRequired = false;
    errMsg = null;
  }

  function statusBadge(status: Branch["status"]) {
    switch (status) {
      case "active":
        return { icon: CheckCircle2, class: "text-emerald-500", label: $t("Branches.status_active") };
      case "creating":
        return { icon: Clock, class: "text-blue-400", label: $t("Branches.status_creating") };
      case "deleting":
        return { icon: Clock, class: "text-amber-400", label: $t("Branches.status_deleting") };
      case "error":
        return { icon: AlertCircle, class: "text-red-500", label: $t("Branches.status_error") };
      default:
        return { icon: XCircle, class: "text-muted-foreground", label: status };
    }
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between gap-4">
    <div>
      <h2 class="text-lg font-semibold flex items-center gap-2">
        <GitBranch class="w-5 h-5 text-brand" />
        {$t("Branches.title")}
      </h2>
      <p class="text-sm text-muted-foreground mt-1">
        {$t("Branches.subtitle")}
      </p>
    </div>
    {#if !showCreate}
      <button
        class="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand/90 transition-colors"
        onclick={() => { showCreate = true; errMsg = null; }}
      >
        <Plus class="w-4 h-4" />
        {$t("Branches.new_branch")}
      </button>
    {/if}
  </div>

  <div class="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm">
    <div class="flex items-start gap-2">
      <ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
      <div>
        <div class="font-medium text-foreground">{$t("Branches.migration_first")}</div>
        <p class="mt-1 text-muted-foreground">
          {$t("Branches.migration_first_description")}
        </p>
      </div>
    </div>
  </div>

  {#if msg}
    <div class="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-400">
      {msg}
    </div>
  {/if}
  {#if errMsg}
    <div class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
      {errMsg}
    </div>
  {/if}

  {#if showCreate}
    <div class="rounded-lg border border-border bg-card p-4 space-y-4">
      <h3 class="font-medium">{$t("Branches.create_branch")}</h3>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          bind:value={branchName}
          placeholder="e.g. feature-add-auth"
          class="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          onkeydown={(event) => { if (event.key === "Enter") handleCreate(); }}
        />
        <select
          bind:value={dataMode}
          class="rounded-md border border-border bg-background px-3 py-2 text-sm"
          aria-label={$t("Branches.data_mode")}
        >
          <option value="schema_only">{$t("Branches.schema_only_recommended")}</option>
          <option value="full_clone">{$t("Branches.schema_and_data")}</option>
        </select>
        <button
          class="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
          onclick={handleCreate}
          disabled={createBranchMut.isPending}
        >
          {#if createBranchMut.isPending}<Loader2 class="w-4 h-4 animate-spin" />{:else}{$t("Branches.create")}{/if}
        </button>
        <button
          class="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          onclick={() => { showCreate = false; branchName = ""; dataMode = "schema_only"; }}
        >
          {$t("Branches.cancel")}
        </button>
      </div>
      <p class="text-xs text-muted-foreground">
        {#if dataMode === "schema_only"}
          {$t("Branches.schema_only_description")}
        {:else}
          {$t("Branches.full_clone_description")}
        {/if}
      </p>
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-12">
      <Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  {:else if loadError}
    <div class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
      {loadError}
    </div>
  {:else if branches.length === 0}
    <div class="rounded-lg border border-dashed border-border py-12 text-center">
      <GitBranch class="w-8 h-8 text-muted-foreground mx-auto mb-2" />
      <p class="text-sm text-muted-foreground">{$t("Branches.empty")}</p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each branches as branch (branch.ref)}
        {@const badge = statusBadge(branch.status)}
        <div class="rounded-lg border border-border bg-card p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-sm font-medium truncate">{branch.name}</span>
                <span class="inline-flex items-center gap-1 text-xs {badge.class}">
                  <badge.icon class="w-3.5 h-3.5" />
                  {badge.label}
                </span>
                <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {branch.data_mode === "schema_only" ? $t("Branches.schema_only") : $t("Branches.schema_and_data")}
                </span>
              </div>
              <div class="mt-1 text-xs text-muted-foreground">
                {$t("Branches.created_at", { values: { timestamp: new Date(branch.created_at).toLocaleString() } })}
              </div>
              {#if branch.error}
                <div class="mt-2 text-xs text-red-400">{branch.error}</div>
              {/if}
            </div>
            <div class="flex items-center gap-2 shrink-0">
              {#if branch.status === "active"}
                <button
                  class="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 px-2.5 py-1 text-xs text-emerald-500 hover:bg-emerald-500/10 transition-colors"
                  onclick={() => openPromotion(branch)}
                  title={$t("Branches.review_migrations_title")}
                >
                  <ArrowUpCircle class="w-3.5 h-3.5" />
                  {$t("Branches.review_migrations")}
                </button>
              {/if}
              <button
                class="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-red-400 hover:border-red-400/30 transition-colors"
                onclick={() => deleteBranchMut.mutate(branch.ref)}
                disabled={deleteBranchMut.isPending || branch.status === "deleting"}
                title={$t("Branches.delete_title")}
              >
                <Trash2 class="w-3.5 h-3.5" />
                {$t("Branches.delete")}
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if promoteTarget}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-card p-6 space-y-5">
        <div class="flex items-start gap-3">
          <ShieldCheck class="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
          <div>
            <h3 class="font-semibold text-base">{$t("Branches.promote_title", { values: { name: promoteTarget.name } })}</h3>
            <p class="mt-1 text-sm text-muted-foreground">
              {$t("Branches.promote_description")}
            </p>
          </div>
        </div>

        {#if promotionPlanMut.isPending}
          <div class="flex items-center justify-center gap-2 rounded-md border border-border py-10 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            {$t("Branches.building_plan")}
          </div>
        {:else if promotionError}
          <div class="space-y-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            <div>{promotionError}</div>
            {#if promotionNeedsRefresh}
              <button
                class="rounded border border-red-500/30 px-2 py-1 text-xs hover:bg-red-500/10 disabled:opacity-50"
                onclick={() => promoteTarget && promotionPlanMut.mutate(promoteTarget.ref)}
                disabled={promotionPlanMut.isPending}
              >{$t("Branches.refresh_plan")}</button>
            {/if}
          </div>
        {:else if !promotionPlan}
          <div class="rounded-md border border-border p-3 text-sm text-muted-foreground">
            {$t("Branches.no_plan")}
          </div>
        {:else}
          <div class="grid grid-cols-3 gap-3 text-center text-xs">
            <div class="rounded-md border border-border p-3"><div class="text-lg font-semibold">{promotionPlan.pending.length}</div><div class="text-muted-foreground">{$t("Branches.pending")}</div></div>
            <div class="rounded-md border border-border p-3"><div class="text-lg font-semibold">{promotionPlan.applied.length}</div><div class="text-muted-foreground">{$t("Branches.applied")}</div></div>
            <div class="rounded-md border border-border p-3"><div class="text-lg font-semibold">{promotionPlan.blocked.length}</div><div class="text-muted-foreground">{$t("Branches.blocked")}</div></div>
          </div>

          <div class="rounded-md border border-border bg-background/50 p-3 text-xs">
            <div class="text-muted-foreground">{$t("Branches.reviewed_plan_checksum")}</div>
            <div class="mt-1 break-all font-mono">{promotionPlan.plan_checksum}</div>
          </div>

          {#if promotionPlan.pending.length > 0}
            <div class="space-y-2">
              <h4 class="text-sm font-medium">{$t("Branches.pending_migrations")}</h4>
              {#each promotionPlan.pending as migration (migration.version)}
                <div class="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-xs">
                  <div class="min-w-0">
                    <div class="font-mono font-medium">{migration.version} · {migration.name || $t("Branches.unnamed")}</div>
                    <div class="mt-1 text-muted-foreground">{$t("Branches.statement_count", { values: { count: migration.statement_count, checksum: migration.checksum.slice(0, 12) } })}</div>
                    <details class="mt-2">
                      <summary class="cursor-pointer text-foreground">{$t("Branches.review_sql")}</summary>
                      <div class="mt-2 space-y-2">
                        {#each migration.statements || [] as statement, index}
                          <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]" aria-label={$t("Branches.migration_statement", { values: { index: index + 1 } })}>{statement}</pre>
                        {/each}
                        {#if !migration.statements?.length}
                          <div class="text-muted-foreground">{$t("Branches.sql_unavailable")}</div>
                        {/if}
                      </div>
                    </details>
                  </div>
                  {#if migration.destructive}
                    <span class="rounded bg-red-500/10 px-2 py-0.5 text-red-400">{$t("Branches.destructive")}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if promotionPlan.blocked.length > 0}
            <div class="space-y-2">
              <h4 class="flex items-center gap-1.5 text-sm font-medium text-red-400"><TriangleAlert class="h-4 w-4" />{$t("Branches.blocking_findings")}</h4>
              {#each promotionPlan.blocked as blocker (`${blocker.code}-${blocker.version}`)}
                <div class="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300">
                  <div class="font-mono">[{blocker.code}] {blocker.version}</div>
                  <div class="mt-1">{blocker.message}</div>
                </div>
              {/each}
            </div>
          {/if}

          {#if promotionPlan.warnings.length > 0}
            <ul class="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {#each promotionPlan.warnings as warning}
                <li>{warning}</li>
              {/each}
            </ul>
          {/if}

          {#if promotionPlan.requires_destructive_confirmation}
            <label class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <input class="mt-0.5" type="checkbox" bind:checked={confirmDestructive} />
              <span>{$t("Branches.destructive_confirmation")}</span>
            </label>
          {/if}
        {/if}

        <div class="flex flex-col-reverse justify-between gap-3 border-t border-border pt-4 sm:flex-row">
          <button
            class="inline-flex items-center justify-center gap-1.5 rounded-md border border-red-500/30 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10"
            onclick={() => openReplacement(promoteTarget!)}
            disabled={promotionPlanMut.isPending || promoteBranchMut.isPending}
          >
            <Database class="h-3.5 w-3.5" />
            {$t("Branches.replace_database")}
          </button>
          <div class="flex justify-end gap-2">
            <button class="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50" onclick={closePromotion} disabled={promoteBranchMut.isPending}>{$t("Branches.cancel")}</button>
            <button
              class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              onclick={() => promotionPlan && promoteBranchMut.mutate({ branchRef: promoteTarget!.ref, plan: promotionPlan })}
              disabled={!promotionPlan || promotionNeedsRefresh || !promotionPlan.safe_to_apply || promotionPlan.pending.length === 0 || (promotionPlan.requires_destructive_confirmation && !confirmDestructive) || promoteBranchMut.isPending}
            >
              {#if promoteBranchMut.isPending}<Loader2 class="h-4 w-4 animate-spin" />{:else if promotionPlan?.pending.length === 0}{$t("Branches.up_to_date_short")}{:else}{$t("Branches.apply_migrations", { values: { count: promotionPlan?.pending.length || 0 } })}{/if}
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if replaceTarget}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
      <div class="w-full max-w-lg rounded-lg border border-red-500/30 bg-card p-6 space-y-4">
        <div class="flex items-start gap-3">
          <TriangleAlert class="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          <div>
            <h3 class="font-semibold text-red-400">{$t("Branches.replace_database")}</h3>
            <p class="mt-1 text-sm text-muted-foreground">
              {$t("Branches.replace_description")}
            </p>
          </div>
        </div>
        <div class="rounded-md bg-red-500/5 p-3 text-xs">
          <span>{$t("Branches.replace_confirmation_prefix")}</span>
          <code class="font-mono text-red-300">{replaceExpected}</code>
          <span>{$t("Branches.replace_confirmation_suffix")}</span>
        </div>
        <input
          bind:value={replaceConfirmation}
          class="w-full rounded-md border border-red-500/30 bg-background px-3 py-2 font-mono text-sm"
          placeholder={replaceExpected}
          autocomplete="off"
        />
        {#if replaceError}
          <div class="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{replaceError}</div>
        {/if}
        {#if replacementRecoveryRequired}
          <div class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            {$t("Branches.replacement_recovery_required")}
          </div>
        {/if}
        <div class="flex justify-end gap-2">
          <button
            class="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            onclick={() => { replaceTarget = null; replaceConfirmation = ""; replaceError = null; }}
            disabled={replacementRecoveryRequired || replaceDatabaseMut.isPending}
          >
            {$t("Branches.cancel")}
          </button>
          <button
            class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            onclick={() => replaceDatabaseMut.mutate(replaceTarget!.ref)}
            disabled={replacementRecoveryRequired || replaceConfirmation !== replaceExpected || replaceDatabaseMut.isPending}
          >
            {#if replaceDatabaseMut.isPending}<Loader2 class="h-4 w-4 animate-spin" />{:else}{$t("Branches.replace_database")}{/if}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
