<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Activity, Server, Pause, RotateCw, Trash2, AlertTriangle, Globe, CheckCircle2, XCircle } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { AutoForm } from "@svadmin/ui";
  import { useShow } from "@svadmin/core";
  import { useQueryClient, createMutation, createQuery } from "@tanstack/svelte-query";

  let actionInProgress = $state<string | null>(null);
  let actionMsg = $state<string | null>(null);
  let customDomainInput = $state("");
  let apiDomainInput = $state("");
  let studioDomainInput = $state("");

  // Custom domain state
  let domainHostname = $state("");
  let domainStatus = $state("not_configured");
  let newDomain = $state("");
  let domainError = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);

  const query = useShow({
    get resource() { return "v1/projects"; },
    get id() { return projectRef; }
  });

  const project = $derived(query.data?.data || null);
  const isLoading = $derived(query.isLoading);
  const routingConfig = $derived(
    ((project as Record<string, unknown> | null)?.config as Record<string, unknown> | undefined) || {}
  );
  const projectApiUrl = $derived(
    ((project as Record<string, unknown> | null)?.api as Record<string, unknown> | undefined)?.url as string
      || (routingConfig?.api_domain ? `https://${routingConfig.api_domain}` : "")
      || (routingConfig?.custom_domain ? `https://${routingConfig.custom_domain}` : "")
  );
  const projectStudioUrl = $derived(
    ((project as Record<string, unknown> | null)?.studio as Record<string, unknown> | undefined)?.url as string
      || (routingConfig?.studio_domain ? `https://${routingConfig.studio_domain}` : "")
      || (typeof window !== 'undefined' ? `${window.location.origin}/project/${projectRef}` : "")
  );

  const queryClient = useQueryClient();

  $effect(() => {
    customDomainInput = typeof routingConfig?.custom_domain === "string" ? routingConfig.custom_domain : "";
    apiDomainInput = typeof routingConfig?.api_domain === "string" ? routingConfig.api_domain : "";
    studioDomainInput = typeof routingConfig?.studio_domain === "string" ? routingConfig.studio_domain : "";
  });

  async function refetchProject() {
    await queryClient.invalidateQueries({ queryKey: ["v1/projects", "getOne", projectRef] });
  }

  function normalizeDomainValue(value: string) {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  function formatDatabaseSize(size: unknown): string {
    const bytes = typeof size === "number"
      ? size
      : typeof size === "string" && size.trim()
        ? Number(size)
        : Number.NaN;
    return Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "—";
  }

  const routingMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          custom_domain: normalizeDomainValue(customDomainInput),
          api_domain: normalizeDomainValue(apiDomainInput),
          studio_domain: normalizeDomainValue(studioDomainInput),
        }),
      });
      if (!res.ok) {
        let message = $t("ProjectSettings.routing_save_failed");
        try {
          const err = await res.json();
          message = err?.message || err?.error || message;
        } catch {}
        throw new Error(message);
      }
      return res.json();
    },
    onMutate: () => {
      actionInProgress = "routing";
    },
    onSuccess: async () => {
      actionMsg = `✅ ${$t("ProjectSettings.routing_saved")}`;
      await queryClient.invalidateQueries({ queryKey: ["custom_hostname", projectRef] });
      await refetchProject();
    },
    onError: (err: unknown) => {
      actionMsg = `❌ ${err instanceof Error ? err.message : $t("ProjectSettings.routing_save_failed")}`;
    },
    onSettled: () => {
      actionInProgress = null;
      setTimeout(() => actionMsg = null, 4000);
    }
  }));

  function saveRoutingSettings() {
    routingMutation.mutate();
  }

  const projectActionMutation = createMutation(() => ({
    mutationFn: async (action: 'restart' | 'pause' | 'restore') => {
      const res = await apiClient(`/v1/projects/${projectRef}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error($t(`ProjectSettings.${action}_failed`));
      await new Promise(r => setTimeout(r, action === "pause" ? 1000 : 2000));
      return action;
    },
    onMutate: (action) => {
      actionInProgress = action;
    },
    onSuccess: (action) => {
      const messageKeys = {
        restart: "ProjectSettings.restart_requested",
        pause: "ProjectSettings.project_paused",
        restore: "ProjectSettings.project_restored",
      } as const;
      actionMsg = `✅ ${$t(messageKeys[action])}`;
      refetchProject();
    },
    onError: (err: unknown, action) => {
      const messageKeys = {
        restart: "ProjectSettings.restart_failed",
        pause: "ProjectSettings.pause_failed",
        restore: "ProjectSettings.restore_failed",
      } as const;
      actionMsg = `❌ ${err instanceof Error ? err.message : $t(messageKeys[action])}`;
    },
    onSettled: () => {
      actionInProgress = null;
      setTimeout(() => actionMsg = null, 4000);
    }
  }));

  function restartProject() {
    projectActionMutation.mutate('restart');
  }

  function pauseProject() {
    if (!confirm($t("ProjectSettings.pause_confirm"))) return;
    projectActionMutation.mutate('pause');
  }

  function restoreProject() {
    projectActionMutation.mutate('restore');
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}`, { method: "DELETE" });
      if (!res.ok) throw new Error($t("ProjectSettings.delete_failed"));
      return true;
    },
    onMutate: () => { actionInProgress = "delete"; },
    onSuccess: () => {
      actionMsg = `✅ ${$t("ProjectSettings.project_deleted")}`;
      setTimeout(() => { window.location.href = "/"; }, 2000);
    },
    onError: () => {
      actionMsg = `❌ ${$t("ProjectSettings.delete_failed")}`;
    },
    onSettled: () => { actionInProgress = null; }
  }));

  function deleteProject() {
    const projectName = typeof project?.name === "string" ? project.name : "";
    const input = prompt($t("ProjectSettings.delete_name_prompt", { values: { name: projectName } }));
    if (input !== projectName) {
      actionMsg = `❌ ${$t("ProjectSettings.delete_name_mismatch")}`;
      setTimeout(() => actionMsg = null, 4000);
      return;
    }
    if (!confirm($t("ProjectSettings.delete_confirm"))) return;
    deleteMutation.mutate();
  }

  // --- Custom Domain ---
  const domainQuery = createQuery(() => ({
    queryKey: ["custom_hostname", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    retry: false
  }));

  $effect(() => {
    if (domainQuery.data) {
      domainHostname = domainQuery.data.custom_hostname || "";
      domainStatus = domainQuery.data.status || "not_configured";
    } else if (domainQuery.isError) {
      domainHostname = "";
      domainStatus = "not_configured";
    }
  });

  const addDomainMutation = createMutation(() => ({
    mutationFn: async (hostname: string) => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom_hostname: hostname })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || $t("ProjectSettings.domain_add_failed"));
      }
      return hostname;
    },
    onSuccess: () => {
      toast.success($t("ProjectSettings.domain_added"));
      newDomain = "";
      domainError = null;
      queryClient.invalidateQueries({ queryKey: ["custom_hostname", projectRef] });
      refetchProject();
    },
    onError: (err: unknown) => {
      domainError = err instanceof Error ? err.message : $t("ProjectSettings.network_error");
    }
  }));

  function addDomain() {
    if (!newDomain.trim()) return;
    addDomainMutation.mutate(newDomain.trim());
  }

  const removeDomainMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`, { method: "DELETE" });
      if (!res.ok) throw new Error($t("ProjectSettings.remove_domain"));
      return true;
    },
    onSuccess: () => {
      toast.success($t("ProjectSettings.domain_removed"));
      queryClient.invalidateQueries({ queryKey: ["custom_hostname", projectRef] });
      refetchProject();
    }
  }));

  function removeDomain() {
    if (!confirm($t("ProjectSettings.remove_domain_confirm", { values: { domain: domainHostname } }))) return;
    removeDomainMutation.mutate();
  }
  const domainLoading = $derived(domainQuery.isPending || addDomainMutation.isPending || removeDomainMutation.isPending);
</script>

<div class="flex flex-col space-y-6">

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if project}
    <div class="space-y-6">
      <!-- General via svadmin AutoForm -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <h2 class="text-lg font-semibold">{$t("Settings.general")}</h2>
        <AutoForm resourceName="v1/projects" id={projectRef} />
      </div>

      <!-- API & Access URLs -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <h2 class="text-lg font-semibold">{$t("ProjectSettings.api_access_urls")}</h2>
        <div class="space-y-3 text-sm">
          {#if Object.keys(routingConfig).length > 0}
            {#if routingConfig?.custom_domain}
              <div>
                <span class="text-xs text-muted-foreground">{$t("ProjectSettings.custom_domain")}</span>
                <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{String(routingConfig.custom_domain)}</p>
              </div>
            {/if}
            {#if routingConfig?.api_domain}
              <div>
                <span class="text-xs text-muted-foreground">{$t("ProjectSettings.api_domain")}</span>
                <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{String(routingConfig.api_domain)}</p>
              </div>
            {/if}
            {#if routingConfig?.studio_domain}
              <div>
                <span class="text-xs text-muted-foreground">{$t("ProjectSettings.studio_domain")}</span>
                <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{String(routingConfig.studio_domain)}</p>
              </div>
            {/if}
            <div>
              <span class="text-xs text-muted-foreground">{$t("ProjectSettings.api_url")}</span>
              <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{projectApiUrl || $t("ProjectSettings.not_available")}</p>
            </div>
            {#if routingConfig?.postgrest_port}
              <div>
                <span class="text-xs text-muted-foreground">{$t("ProjectSettings.postgrest_port")}</span>
                <p class="font-mono text-xs">{String(routingConfig.postgrest_port)}</p>
              </div>
            {/if}
            {#if routingConfig?.gotrue_port}
              <div>
                <span class="text-xs text-muted-foreground">{$t("ProjectSettings.gotrue_port")}</span>
                <p class="font-mono text-xs">{String(routingConfig.gotrue_port)}</p>
              </div>
            {/if}
          {:else}
            <div>
              <span class="text-xs text-muted-foreground">{$t("ProjectSettings.api_url")}</span>
              <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{projectApiUrl || $t("ProjectSettings.not_available")}</p>
            </div>
          {/if}
          <div>
            <span class="text-xs text-muted-foreground">{$t("ProjectSettings.studio_url")}</span>
            <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{projectStudioUrl || $t("ProjectSettings.not_available")}</p>
          </div>
        </div>
      </div>

      <div class="border rounded-xl bg-card p-6 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="text-lg font-semibold">{$t("ProjectSettings.routing_domains")}</h2>
            <p class="text-xs text-muted-foreground mt-1">
              {$t("ProjectSettings.routing_description")}
            </p>
          </div>
          <button
            onclick={saveRoutingSettings}
            disabled={routingMutation.isPending}
            class="px-4 py-2 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {#if routingMutation.isPending}
              <Loader2 size={14} class="animate-spin" />
            {/if}
            {$t("ProjectSettings.save")}
          </button>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <label class="space-y-2">
            <span class="text-xs text-muted-foreground">{$t("ProjectSettings.custom_domain")}</span>
            <input
              type="text"
              bind:value={customDomainInput}
              placeholder={$t("ProjectSettings.domain_example")}
              class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 font-mono"
            />
          </label>

          <label class="space-y-2">
            <span class="text-xs text-muted-foreground">{$t("ProjectSettings.api_domain")}</span>
            <input
              type="text"
              bind:value={apiDomainInput}
              placeholder="e.g. api.example.com"
              class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 font-mono"
            />
          </label>

          <label class="space-y-2">
            <span class="text-xs text-muted-foreground">{$t("ProjectSettings.studio_domain")}</span>
            <input
              type="text"
              bind:value={studioDomainInput}
              placeholder="e.g. studio.example.com"
              class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 font-mono"
            />
          </label>
        </div>
      </div>

      <!-- Custom Domain -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <Globe size={16} />
            {$t("ProjectSettings.custom_domain")}
          </h2>
          {#if domainHostname}
            <span class="text-[10px] px-2.5 py-1 rounded-full bg-green-500/10 text-green-600 font-semibold flex items-center gap-1">
              <CheckCircle2 size={10} /> {$t("ProjectSettings.custom_domain_active")}
            </span>
          {/if}
        </div>

        {#if domainHostname}
          <!-- Current domain -->
          <div class="rounded-lg border bg-background p-4 space-y-3">
            <div>
              <span class="text-xs text-muted-foreground">{$t("ProjectSettings.current_domain")}</span>
              <p class="font-mono text-sm font-semibold mt-1">{domainHostname}</p>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div class="rounded-lg bg-muted/30 p-3">
                <span class="text-muted-foreground">{$t("ProjectSettings.api_endpoint")}</span>
                <p class="font-mono mt-1 select-all">https://{domainHostname}</p>
              </div>
              <div class="rounded-lg bg-muted/30 p-3">
                <span class="text-muted-foreground">{$t("ProjectSettings.auth_endpoint")}</span>
                <p class="font-mono mt-1 select-all">https://{domainHostname}/auth/v1</p>
              </div>
            </div>
            <div class="pt-2 border-t">
              <button onclick={removeDomain} disabled={domainLoading}
                class="text-xs text-destructive hover:text-destructive/80 font-medium transition-colors disabled:opacity-50">
                {#if domainLoading}<Loader2 size={12} class="animate-spin inline mr-1" />{/if}
                {$t("ProjectSettings.remove_domain")}
              </button>
            </div>
          </div>

          <!-- DNS Instructions -->
          <div class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 space-y-2">
            <h3 class="text-xs font-semibold text-amber-700">{$t("ProjectSettings.dns_configuration_required")}</h3>
            <p class="text-[10px] text-muted-foreground">{$t("ProjectSettings.dns_configuration_description")}</p>
            <div class="font-mono text-[11px] bg-background rounded p-3 space-y-1 select-all">
              <div>A&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{domainHostname}&nbsp;&nbsp;→&nbsp;&nbsp;82.157.196.165</div>
            </div>
          </div>
        {:else}
          <!-- Add domain form -->
          <div class="space-y-3">
            <p class="text-xs text-muted-foreground">{$t("ProjectSettings.domain_bind_description")}</p>
            <div class="flex gap-2">
              <input type="text" bind:value={newDomain} placeholder="e.g. api.example.com"
                class="flex-1 px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 font-mono"
                onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && addDomain()} />
              <button onclick={addDomain} disabled={domainLoading || !newDomain.trim()}
                class="px-4 py-2 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center gap-2">
                {#if domainLoading}<Loader2 size={14} class="animate-spin" />{/if}
                {$t("ProjectSettings.add_domain")}
              </button>
            </div>
            {#if domainError}
              <p class="text-xs text-destructive flex items-center gap-1"><XCircle size={12} /> {domainError}</p>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Services -->
      {#if (project as Record<string, unknown>)?.services}
        <div class="border rounded-xl bg-card p-6 space-y-4">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <Server size={16} />
            {$t("Settings.services")}
          </h2>
          <div class="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {#each ((project as Record<string, unknown>)?.services as unknown[] || []) as service ((service as Record<string, unknown>).name)}
              <div class="flex items-center justify-between p-3 rounded-lg border bg-background">
                <div class="flex items-center gap-2">
                  <Activity size={14} class={(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? 'text-green-500' : 'text-muted-foreground'} />
                  <span class="text-sm font-medium">{(service as Record<string, unknown>).name}</span>
                </div>
                <span class="text-[10px] px-2 py-0.5 rounded-full {(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground'}">
                  {(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? $t("Settings.active") : $t("Settings.inactive")}
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Database Info -->
      {#if (project as Record<string, unknown>)?.database}
        <div class="border rounded-xl bg-card p-6 space-y-4">
          <h2 class="text-lg font-semibold">{$t("Settings.database_info")}</h2>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span class="text-xs text-muted-foreground">PostgreSQL</span>
              <p class="font-mono text-xs">v{((project as Record<string, unknown>)?.database as Record<string, unknown>)?.version}</p>
            </div>
            <div>
              <span class="text-xs text-muted-foreground">{$t("Dashboard.db_connections")}</span>
              <p class="font-mono text-xs">{((project as Record<string, unknown>)?.database as Record<string, unknown>)?.connection_count}</p>
            </div>
            <div>
              <span class="text-xs text-muted-foreground">{$t("Settings.db_size")}</span>
              <p class="font-mono text-xs">{formatDatabaseSize(((project as Record<string, unknown>)?.database as Record<string, unknown>)?.size)}</p>
            </div>
          </div>
        </div>
      {/if}

      <!-- Project Actions -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <h2 class="text-lg font-semibold">{$t("ProjectSettings.project_actions")}</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button onclick={restartProject} disabled={!!actionInProgress}
            class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
            {#if actionInProgress === "restart"}<Loader2 size={16} class="animate-spin" />{:else}<RotateCw size={16} />{/if}
            {$t("ProjectSettings.restart_project")}
          </button>
          {#if (project as Record<string, unknown>)?.status === "active"}
            <button onclick={pauseProject} disabled={!!actionInProgress}
              class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg border border-amber-500 text-amber-600 hover:bg-amber-500/10 transition-colors disabled:opacity-50">
              {#if actionInProgress === "pause"}<Loader2 size={16} class="animate-spin" />{:else}<Pause size={16} />{/if}
              {$t("ProjectSettings.pause_project")}
            </button>
          {:else}
            <button onclick={restoreProject} disabled={!!actionInProgress}
              class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50">
              {#if actionInProgress === "restore"}<Loader2 size={16} class="animate-spin" />{:else}<Activity size={16} />{/if}
              {$t("ProjectSettings.restore_project")}
            </button>
          {/if}
        </div>
      </div>

      <!-- Danger Zone -->
      <div class="border border-destructive/30 rounded-xl bg-destructive/5 p-6 space-y-4">
        <div class="flex items-center gap-2">
          <AlertTriangle size={16} class="text-destructive" />
          <h2 class="text-lg font-semibold text-destructive">{$t("ProjectSettings.danger_zone")}</h2>
        </div>
        <p class="text-xs text-muted-foreground">{$t("ProjectSettings.delete_description")}</p>
        <button onclick={deleteProject} disabled={!!actionInProgress}
          class="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-destructive text-white hover:bg-destructive/90 transition-colors disabled:opacity-50">
          {#if actionInProgress === "delete"}<Loader2 size={16} class="animate-spin" />{:else}<Trash2 size={16} />{/if}
          {$t("ProjectSettings.delete_project")}
        </button>
      </div>
    </div>
  {/if}
</div>
