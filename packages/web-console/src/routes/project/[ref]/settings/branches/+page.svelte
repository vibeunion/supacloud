<script lang="ts">
  import { page } from "$app/state";
  import { GitBranch, Plus, Trash2, Loader2, ArrowUpCircle, CheckCircle2, XCircle, Clock, AlertCircle } from "lucide-svelte";
  import { apiClient } from "$lib/api";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface Branch {
    ref: string;
    name: string;
    parent_ref: string;
    status: "creating" | "active" | "deleting" | "error";
    created_at: string;
    error?: string;
  }

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  let showCreate = $state(false);
  let branchName = $state("");
  let msg = $state<string | null>(null);
  let errMsg = $state<string | null>(null);
  let promoteTarget = $state<Branch | null>(null);

  const branchesQuery = createQuery(() => ({
    queryKey: ["branches", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/branches`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || "Failed to load branches");
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
        body: JSON.stringify({ name: branchName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || "Failed to create branch");
      return data;
    },
    onSuccess: () => {
      showCreate = false;
      branchName = "";
      msg = "Branch created, provisioning database...";
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
      if (!res.ok) throw new Error(data.error || data.message || "Failed to delete branch");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branches", projectRef] });
    },
  }));

  const promoteBranchMut = createMutation(() => ({
    mutationFn: async (branchRef: string) => {
      const res = await apiClient(`/v1/projects/${projectRef}/branches/${branchRef}/promote`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || "Failed to promote branch");
      return data;
    },
    onSuccess: () => {
      promoteTarget = null;
      msg = "Branch promoted to parent project.";
      setTimeout(() => (msg = null), 4000);
      queryClient.invalidateQueries({ queryKey: ["branches", projectRef] });
    },
    onError: (err: unknown) => {
      errMsg = err instanceof Error ? err.message : String(err);
    },
  }));

  function handleCreate() {
    errMsg = null;
    if (!branchName.trim()) {
      errMsg = "Branch name is required.";
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(branchName.trim())) {
      errMsg = "Branch name may only contain letters, numbers, dots, dashes, underscores.";
      return;
    }
    createBranchMut.mutate();
  }

  function statusBadge(status: Branch["status"]) {
    switch (status) {
      case "active":
        return { icon: CheckCircle2, class: "text-emerald-500", label: "Active" };
      case "creating":
        return { icon: Clock, class: "text-blue-400", label: "Creating" };
      case "deleting":
        return { icon: Clock, class: "text-amber-400", label: "Deleting" };
      case "error":
        return { icon: AlertCircle, class: "text-red-500", label: "Error" };
      default:
        return { icon: XCircle, class: "text-muted-foreground", label: status };
    }
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-semibold flex items-center gap-2">
        <GitBranch class="w-5 h-5 text-brand" />
        Branches
      </h2>
      <p class="text-sm text-muted-foreground mt-1">
        Create preview branches with cloned databases for testing schema changes and migrations.
      </p>
    </div>
    {#if !showCreate}
      <button
        class="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand/90 transition-colors"
        onclick={() => { showCreate = true; errMsg = null; }}
      >
        <Plus class="w-4 h-4" />
        New Branch
      </button>
    {/if}
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
    <div class="rounded-lg border border-border bg-card p-4 space-y-3">
      <h3 class="font-medium">Create New Branch</h3>
      <div class="flex items-center gap-2">
        <input
          type="text"
          bind:value={branchName}
          placeholder="e.g. feature-add-auth"
          class="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          onkeydown={(e) => { if (e.key === "Enter") handleCreate(); }}
        />
        <button
          class="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
          onclick={handleCreate}
          disabled={createBranchMut.isPending}
        >
          {#if createBranchMut.isPending}<Loader2 class="w-4 h-4 animate-spin" />{:else}Create{/if}
        </button>
        <button
          class="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          onclick={() => { showCreate = false; branchName = ""; }}
        >
          Cancel
        </button>
      </div>
      <p class="text-xs text-muted-foreground">
        The parent project's database (schema + data) will be cloned into a new preview database.
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
      <p class="text-sm text-muted-foreground">No branches yet. Create one to get started.</p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each branches as branch (branch.ref)}
        {@const badge = statusBadge(branch.status)}
        <div class="rounded-lg border border-border bg-card p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="font-mono text-sm font-medium truncate">{branch.name}</span>
                <span class="inline-flex items-center gap-1 text-xs {badge.class}">
                  <badge.icon class="w-3.5 h-3.5" />
                  {badge.label}
                </span>
              </div>
              <div class="mt-1 text-xs text-muted-foreground">
                Created {new Date(branch.created_at).toLocaleString()}
              </div>
              {#if branch.error}
                <div class="mt-2 text-xs text-red-400">{branch.error}</div>
              {/if}
            </div>
            <div class="flex items-center gap-2 shrink-0">
              {#if branch.status === "active"}
                <button
                  class="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                  onclick={() => { promoteTarget = branch; errMsg = null; }}
                  title="Promote this branch back to the parent (overwrites parent DB)"
                >
                  <ArrowUpCircle class="w-3.5 h-3.5" />
                  Promote
                </button>
              {/if}
              <button
                class="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-red-400 hover:border-red-400/30 transition-colors"
                onclick={() => deleteBranchMut.mutate(branch.ref)}
                disabled={deleteBranchMut.isPending || branch.status === "deleting"}
                title="Delete this branch"
              >
                <Trash2 class="w-3.5 h-3.5" />
                Delete
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if promoteTarget}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
      <div class="rounded-lg border border-border bg-card p-6 max-w-md w-full mx-4 space-y-4">
        <div class="flex items-center gap-2">
          <ArrowUpCircle class="w-5 h-5 text-amber-400" />
          <h3 class="font-semibold text-base">Promote "{promoteTarget.name}"?</h3>
        </div>
        <p class="text-sm text-muted-foreground">
          This will <strong class="text-foreground">overwrite</strong> the parent project's database with the branch's data.
          The parent will be temporarily stopped during the operation. This action cannot be undone.
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <button
            class="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            onclick={() => { promoteTarget = null; }}
          >
            Cancel
          </button>
          <button
            class="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
            onclick={() => promoteBranchMut.mutate(promoteTarget!.ref)}
            disabled={promoteBranchMut.isPending}
          >
            {#if promoteBranchMut.isPending}<Loader2 class="w-4 h-4 animate-spin" />{:else}Promote Now{/if}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
