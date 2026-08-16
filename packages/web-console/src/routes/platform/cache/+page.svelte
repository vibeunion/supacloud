<script lang="ts">
  import { apiClient } from "$lib/api";
  import { onMount } from "svelte";
  import {
    Activity,
    AlertTriangle,
    CheckCircle2,
    Database,
    Gauge,
    Loader2,
    MemoryStick,
    RefreshCw,
    ShieldCheck,
    Users,
  } from "lucide-svelte";
  import { t } from "svelte-i18n";
  import { toast } from "svelte-sonner";

  type PlatformCacheStatus = {
    configured: boolean;
    ok: boolean;
    service: string;
    namespace: string;
    queue: false;
    rateLimit: false;
    activeTenants: number;
    maxTenants: number;
    connectionsPerTenant: number;
    l1: {
      enabled: boolean;
      maxEntries: number;
      ttlMs: number;
    };
    tenants: Array<{
      projectRef: string;
      leases: number;
      lastUsedAt: string;
    }>;
  };

  let status = $state<PlatformCacheStatus | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let loadError = $state<string | null>(null);

  async function loadStatus(silent = false) {
    if (silent) refreshing = true;
    else {
      loading = true;
      loadError = null;
    }
    try {
      const response = await apiClient("/v1/cache");
      const responsePayload: unknown = await response.json().catch(() => ({}));
      const payload = responsePayload && typeof responsePayload === "object" && !Array.isArray(responsePayload)
        ? responsePayload as Record<string, unknown>
        : {};
      if (!response.ok) {
        const message = typeof payload.message === "string"
          ? payload.message
          : typeof payload.error === "string"
            ? payload.error
            : $t("Cache.request_failed");
        throw new Error(message);
      }
      status = payload as unknown as PlatformCacheStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : $t("Cache.request_failed");
      if (!silent) loadError = message;
      toast.error(message);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  onMount(() => {
    void loadStatus();
  });
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex items-center gap-2">
        <MemoryStick class="h-6 w-6 text-brand" />
        <h2 class="text-xl font-bold">{$t("Cache.platform_title")}</h2>
      </div>
      <p class="mt-1 text-sm text-muted-foreground">{$t("Cache.platform_subtitle")}</p>
    </div>
    <button
      type="button"
      onclick={() => loadStatus(true)}
      disabled={refreshing}
      class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
    >
      <RefreshCw class={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      {$t("Cache.refresh")}
    </button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center gap-2 rounded-xl border bg-card py-16 text-sm text-muted-foreground">
      <Loader2 class="h-5 w-5 animate-spin" />
      {$t("Cache.loading")}
    </div>
  {:else if loadError}
    <div class="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
      <AlertTriangle class="mt-0.5 h-5 w-5 shrink-0" />
      <span>{loadError}</span>
    </div>
  {:else if status && !status.configured}
    <div class="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-700 dark:text-amber-300">
      <AlertTriangle class="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p class="font-semibold">{$t("Cache.not_configured")}</p>
        <p class="mt-1 text-xs opacity-80">{$t("Cache.not_configured_desc")}</p>
        <p class="mt-2 text-xs opacity-80">{$t("Cache.not_configured_guidance")}</p>
        <a
          href="https://github.com/vibeunion/supacloud/blob/main/docs/pgredis-runtime.md"
          target="_blank"
          rel="noreferrer"
          class="mt-3 inline-block font-medium underline underline-offset-2 hover:no-underline"
        >{$t("Cache.configuration_guide")}</a>
      </div>
    </div>
  {:else if status}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{$t("Cache.data_plane")}</p>
          <CheckCircle2 class="h-4 w-4 text-emerald-500" />
        </div>
        <p class="mt-3 text-lg font-semibold">{status.ok ? $t("Cache.available") : $t("Cache.unavailable")}</p>
        <p class="mt-1 font-mono text-xs text-muted-foreground">{status.service} · {status.namespace}</p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{$t("Cache.tenant_capacity")}</p>
          <Users class="h-4 w-4 text-brand" />
        </div>
        <p class="mt-3 text-lg font-semibold tabular-nums">{status.activeTenants} / {status.maxTenants}</p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{$t("Cache.connections_per_tenant")}</p>
          <Database class="h-4 w-4 text-brand" />
        </div>
        <p class="mt-3 text-lg font-semibold tabular-nums">{status.connectionsPerTenant}</p>
      </div>
      <div class="rounded-xl border bg-card p-4">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{$t("Cache.l1_cache")}</p>
          <Gauge class="h-4 w-4 text-brand" />
        </div>
        <p class="mt-3 text-lg font-semibold">{status.l1.enabled ? $t("Cache.active") : $t("Cache.inactive")}</p>
        <p class="mt-1 text-xs text-muted-foreground">{$t("Cache.max_entries")}: {status.l1.maxEntries} · {$t("Cache.l1_ttl")}: {status.l1.ttlMs} ms</p>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <div class="rounded-xl border bg-card p-5">
        <div class="flex items-start gap-3">
          <Activity class="mt-0.5 h-5 w-5 text-brand" />
          <div>
            <h3 class="font-semibold">{$t("Cache.queue_owner")}</h3>
            <p class="mt-1 text-sm text-muted-foreground">{$t("Cache.queue_owner_desc")}</p>
          </div>
        </div>
      </div>
      <div class="rounded-xl border bg-card p-5">
        <div class="flex items-start gap-3">
          <ShieldCheck class="mt-0.5 h-5 w-5 text-brand" />
          <div>
            <h3 class="font-semibold">{$t("Cache.rate_limit_owner")}</h3>
            <p class="mt-1 text-sm text-muted-foreground">{$t("Cache.rate_limit_owner_desc")}</p>
          </div>
        </div>
      </div>
    </div>

    <section class="overflow-hidden rounded-xl border bg-card">
      <div class="border-b px-5 py-4">
        <h3 class="font-semibold">{$t("Cache.active_tenants")}</h3>
      </div>
      {#if status.tenants.length === 0}
        <div class="px-5 py-12 text-center text-sm text-muted-foreground">{$t("Cache.no_active_tenants")}</div>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th class="px-5 py-3 font-medium">{$t("Cache.project_ref")}</th>
                <th class="px-5 py-3 font-medium">{$t("Cache.leases")}</th>
                <th class="px-5 py-3 font-medium">{$t("Cache.last_used")}</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              {#each status.tenants as tenant (tenant.projectRef)}
                <tr class="hover:bg-muted/20">
                  <td class="px-5 py-3 font-mono text-xs">{tenant.projectRef}</td>
                  <td class="px-5 py-3 tabular-nums">{tenant.leases}</td>
                  <td class="px-5 py-3 text-muted-foreground">{new Date(tenant.lastUsedAt).toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</div>
