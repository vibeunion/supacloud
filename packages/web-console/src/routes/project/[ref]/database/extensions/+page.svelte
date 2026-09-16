<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Package, Check, X, Search } from "lucide-svelte";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";

  interface Extension {
    name: string;
    default_version: string;
    installed_version: string | null;
    schema: string | null;
    comment: string;
    is_installed: boolean;
    is_enabled?: boolean;
    runtime_status?: "not_installed" | "unmanaged" | "paused" | "worker_not_ready" | "running";
    kind: "extension" | "workflow";
    available: boolean;
    can_enable: boolean;
    can_disable: boolean;
    blocked_reason: string | null;
  }

  let searchQuery = $state("");
  let toggleError = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const extensionsQuery = createQuery(() => ({
    queryKey: ["database_extensions", projectRef],
    refetchInterval: 15_000,
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/extensions/catalog`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      if (!Array.isArray(data)) throw new Error("Invalid extension inventory response");
      return data as Extension[];
    }
  }));

  const extensions = $derived((extensionsQuery.data as Extension[]) || []);
  const isLoading = $derived(extensionsQuery.isPending);
  const error = $derived(extensionsQuery.error?.message || toggleError);

  let togglingExt = $state<string | null>(null);

  async function toggleExtension(ext: Extension) {
    if (togglingExt !== null) return;
    const currentlyEnabled = ext.is_enabled ?? ext.is_installed;
    if (currentlyEnabled ? !ext.can_disable : !ext.can_enable) return;
    if (currentlyEnabled && ext.kind !== "workflow" && !confirm($t("Extensions.confirm_disable", { values: { name: ext.name } }))) return;
    const targetRef = projectRef;
    togglingExt = ext.name;
    toggleError = null;
    const isEnabling = !currentlyEnabled;
    try {
      const res = await apiClient(`/v1/projects/${targetRef}/database/extensions`, {
        method: isEnabling ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEnabling ? { name: ext.name, schema: ext.schema || undefined } : { name: ext.name })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      if (data.name !== ext.name || (data.is_enabled ?? data.is_installed) !== isEnabling) {
        throw new Error("Extension outcome could not be confirmed; refresh its state before retrying.");
      }
    } catch (err: unknown) {
      toggleError = err instanceof Error ? err.message : String(err);
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["database_extensions", targetRef] });
      togglingExt = null;
    }
  }

  const filteredExtensions = $derived(
    searchQuery
      ? extensions.filter(e => e.name.toLowerCase().includes(searchQuery.toLowerCase()) || (e.comment || "").toLowerCase().includes(searchQuery.toLowerCase()))
      : extensions
  );

  const enabledCount = $derived(extensions.filter(e => e.is_enabled ?? e.is_installed).length);

  function extensionDescription(extension: Extension): string {
    return $t("Extensions.official_description", {
      values: { name: extension.name, description: extension.comment || "—" },
    });
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("Extensions.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Extensions.subtitle")}</p>
    </div>
    {#if !isLoading}
      <div class="flex items-center gap-3 text-xs text-muted-foreground">
        <span class="px-2 py-1 rounded bg-green-500/10 text-green-600 font-bold">{enabledCount} {$t("Extensions.enabled")}</span>
        <span class="px-2 py-1 rounded bg-muted text-muted-foreground font-bold">{extensions.length - enabledCount} {$t("Extensions.disabled")}</span>
      </div>
    {/if}
  </div>

  <div class="relative w-64">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input
      bind:value={searchQuery}
      placeholder={$t("Extensions.search")}
      class="w-full pl-9 pr-3 py-1.5 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
    />
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden flex flex-col">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("Extensions.loading")}</p>
      </div>
    {:else}
      {#if error}
        <div class="p-4 border-b">
          <div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{error}</div>
        </div>
      {/if}
      <div class="overflow-auto flex-1">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0 z-10">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Extensions.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Extensions.version")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Extensions.schema")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground">{$t("Extensions.description")}</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground text-right">{$t("Extensions.status_action")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each filteredExtensions as ext}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <Package size={13} class={(ext.is_enabled ?? ext.is_installed) ? "text-green-500" : "text-muted-foreground/40"} />
                    <span class="font-mono font-medium">{ext.name}</span>
                  </div>
                </td>
                <td class="px-3 py-2.5 font-mono text-muted-foreground tabular-nums">
                  {ext.installed_version || ext.default_version || "—"}
                </td>
                <td class="px-3 py-2.5 font-mono text-muted-foreground">
                  {ext.schema || "—"}
                </td>
                <td class="px-3 py-2.5 text-muted-foreground max-w-sm break-words">
                  {extensionDescription(ext)}
                  {#if ext.blocked_reason}<p class="mt-1 text-xs text-amber-700">{ext.blocked_reason}</p>{/if}
                </td>
                <td class="px-4 py-2.5 text-right">
                  <div class="flex items-center justify-end gap-2">
                    {#if ext.is_enabled ?? ext.is_installed}
                      <span class={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${ext.runtime_status === "worker_not_ready" ? "bg-amber-500/10 text-amber-700" : "bg-green-500/10 text-green-600"}`}>
                        <Check size={10} /> {$t(ext.runtime_status ? `Extensions.pgflow_${ext.runtime_status}` : "Extensions.enabled")}
                      </span>
                      <button onclick={() => toggleExtension(ext)} disabled={togglingExt !== null || !ext.can_disable} title={ext.blocked_reason || ""}
                        class="ml-2 px-2 py-1 text-[10px] rounded border border-destructive/20 text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-1 disabled:opacity-50">
                        {#if togglingExt === ext.name}<Loader2 size={10} class="animate-spin" />{:else}<X size={10} />{/if} {$t(ext.kind === "workflow" ? "Extensions.pause" : "Extensions.disable")}
                      </button>
                    {:else}
                      <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px]">
                        <X size={10} /> {$t(ext.runtime_status ? `Extensions.pgflow_${ext.runtime_status}` : ext.available ? "Extensions.disabled" : "Extensions.setup_required")}
                      </span>
                      <button onclick={() => toggleExtension(ext)} disabled={togglingExt !== null || !ext.can_enable} title={ext.blocked_reason || ""}
                        class="ml-2 px-2 py-1 text-[10px] rounded border border-brand/20 text-brand hover:bg-brand/10 transition-colors flex items-center gap-1 disabled:opacity-50">
                        {#if togglingExt === ext.name}<Loader2 size={10} class="animate-spin" />{:else}<Check size={10} />{/if} {$t("Extensions.enable")}
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
