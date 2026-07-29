<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import {
    migrateOAuthServerWithReadback,
    type OAuthServerStatus,
  } from "./oauth-server-migration";
  import {
    AlertTriangle,
    CheckCircle2,
    Copy,
    KeyRound,
    Loader2,
    Plus,
    RefreshCw,
    ShieldCheck,
    Trash2,
  } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { t } from "svelte-i18n";

  type OAuthClient = {
    id?: string;
    client_id?: string;
    name?: string;
    client_name?: string;
    redirect_uris?: string[];
    client_type?: string;
    token_endpoint_auth_method?: string;
    created_at?: string;
  };

  const projectRef = $derived(page.params.ref);

  let statusData = $state<OAuthServerStatus | null>(null);
  let clients = $state<OAuthClient[]>([]);
  let loading = $state(true);
  let clientsLoading = $state(false);
  let saving = $state(false);
  let errorMessage = $state("");
  let allowDynamicRegistration = $state(false);
  let clientName = $state("");
  let redirectUrisText = $state("");
  let clientType = $state<"confidential" | "public">("confidential");
  let authMethod = $state<"client_secret_basic" | "client_secret_post" | "none">("client_secret_basic");

  const endpointRows = $derived(statusData ? [
    { label: $t("OAuthServer.endpoint_authorization"), value: statusData.authorization_endpoint },
    { label: $t("OAuthServer.endpoint_token"), value: statusData.token_endpoint },
    { label: $t("OAuthServer.endpoint_jwks"), value: statusData.jwks_url },
    { label: $t("OAuthServer.endpoint_discovery"), value: statusData.oauth_authorization_server_metadata_url },
    { label: $t("OAuthServer.endpoint_oidc"), value: statusData.discovery_url },
  ] : []);

  function normalizeClients(payload: unknown): OAuthClient[] {
    if (Array.isArray(payload)) return payload as OAuthClient[];
    if (payload && typeof payload === "object") {
      const data = payload as { clients?: unknown; data?: unknown };
      if (Array.isArray(data.clients)) return data.clients as OAuthClient[];
      if (Array.isArray(data.data)) return data.data as OAuthClient[];
    }
    return [];
  }

  async function readJson(res: Response): Promise<any> {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async function loadOAuthServer() {
    loading = true;
    errorMessage = "";
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/oauth-server`);
      const payload = await readJson(res);
      if (!res.ok) throw new Error(payload.message || $t("OAuthServer.load_failed"));
      statusData = payload;
      allowDynamicRegistration = payload.allow_dynamic_registration === true;
      if (payload.enabled) await loadClients();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  async function loadClients() {
    clientsLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/oauth-clients`);
      const payload = await readJson(res);
      if (!res.ok) throw new Error(payload.message || $t("OAuthServer.clients_load_failed"));
      clients = normalizeClients(payload);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      clientsLoading = false;
    }
  }

  async function migrate() {
    saving = true;
    try {
      statusData = await migrateOAuthServerWithReadback(
        async () => {
          const response = await apiClient(`/v1/projects/${projectRef}/auth/oauth-server/migrate`, {
            method: "POST",
            body: JSON.stringify({ allow_dynamic_registration: allowDynamicRegistration }),
          });
          return { response, payload: await readJson(response) };
        },
        async () => {
          const response = await apiClient(`/v1/projects/${projectRef}/auth/oauth-server`);
          return { response, payload: await readJson(response) };
        },
      );
      toast.success($t("OAuthServer.enabled_success"));
      await loadClients();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      saving = false;
    }
  }

  async function createClient() {
    const redirectUris = redirectUrisText
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!clientName.trim() || redirectUris.length === 0) {
      toast.error($t("OAuthServer.client_required"));
      return;
    }

    saving = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/oauth-clients`, {
        method: "POST",
        body: JSON.stringify({
          client_name: clientName.trim(),
          redirect_uris: redirectUris,
          client_type: clientType,
          token_endpoint_auth_method: clientType === "public" ? "none" : authMethod,
        }),
      });
      const payload = await readJson(res);
      if (!res.ok) throw new Error(payload.message || $t("OAuthServer.client_create_failed"));
      clientName = "";
      redirectUrisText = "";
      toast.success($t("OAuthServer.client_created"));
      await loadClients();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      saving = false;
    }
  }

  async function deleteClient(client: OAuthClient) {
    const clientId = client.client_id || client.id;
    if (!clientId) return;
    const clientName = client.client_name || client.name || clientId;
    if (!confirm($t("OAuthServer.client_delete_confirmation", { values: { name: clientName } }))) return;
    saving = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/oauth-clients/${encodeURIComponent(clientId)}`, {
        method: "DELETE",
      });
      const payload = await readJson(res);
      if (!res.ok) throw new Error(payload.message || $t("OAuthServer.client_delete_failed"));
      toast.success($t("OAuthServer.client_deleted"));
      await loadClients();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      saving = false;
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success($t("Common.copied"));
    } catch {
      toast.error($t("Common.copy_failed"));
    }
  }

  onMount(loadOAuthServer);
</script>

<div class="flex flex-col gap-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">{$t("OAuthServer.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("OAuthServer.subtitle")}</p>
    </div>
    <button
      class="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50 disabled:opacity-50"
      onclick={loadOAuthServer}
      disabled={loading || saving}
    >
      <RefreshCw size={14} class={loading ? "animate-spin" : ""} />
      {$t("Common.refresh")}
    </button>
  </div>

  {#if loading}
    <div class="flex min-h-[360px] items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-60" />
    </div>
  {:else if errorMessage}
    <div class="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      {errorMessage}
    </div>
  {:else if statusData}
    <div class="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <section class="rounded-lg border bg-card">
        <div class="flex items-center justify-between gap-3 border-b px-5 py-4">
          <div class="flex items-center gap-2">
            <ShieldCheck size={18} class={statusData.enabled ? "text-green-600" : "text-amber-600"} />
            <h2 class="font-semibold">{$t("OAuthServer.service_status")}</h2>
          </div>
          <span class="rounded-full px-2.5 py-1 text-xs font-semibold {statusData.enabled ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700'}">
            {statusData.enabled ? $t("OAuthServer.enabled") : $t("OAuthServer.disabled")}
          </span>
        </div>
        <div class="space-y-4 p-5">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-md border bg-muted/20 p-3">
              <div class="text-xs text-muted-foreground">{$t("OAuthServer.signing_algorithm")}</div>
              <div class="mt-1 font-mono text-sm font-semibold">{statusData.signing_alg}</div>
            </div>
            <div class="rounded-md border bg-muted/20 p-3">
              <div class="text-xs text-muted-foreground">ID Token</div>
              <div class="mt-1 text-sm font-semibold">{statusData.oidc_id_token_ready ? $t("OAuthServer.ready") : $t("OAuthServer.not_ready")}</div>
            </div>
            <div class="rounded-md border bg-muted/20 p-3">
              <div class="text-xs text-muted-foreground">{$t("OAuthServer.dynamic_registration")}</div>
              <div class="mt-1 text-sm font-semibold">{statusData.allow_dynamic_registration ? $t("OAuthServer.allowed") : $t("OAuthServer.disabled")}</div>
            </div>
          </div>

          {#if statusData.warnings?.length}
            <div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              {#each statusData.warnings as warning (warning)}
                <div class="flex items-start gap-2 text-sm text-amber-800">
                  <AlertTriangle size={15} class="mt-0.5 shrink-0" />
                  <span>{warning}</span>
                </div>
              {/each}
            </div>
          {/if}

          <div class="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-sm text-amber-800">
            {$t("OAuthServer.rls_warning")}
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={allowDynamicRegistration} class="h-4 w-4 rounded border" />
            {$t("OAuthServer.allow_dynamic_registration")}
          </label>

          <button
            class="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
            onclick={migrate}
            disabled={saving}
          >
            {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<KeyRound size={14} />{/if}
            {statusData.enabled ? $t("OAuthServer.reapply_configuration") : $t("OAuthServer.enable")}
          </button>
        </div>
      </section>

      <section class="rounded-lg border bg-card">
        <div class="border-b px-5 py-4">
        <h2 class="font-semibold">{$t("OAuthServer.edge_compatibility")}</h2>
        </div>
        <div class="space-y-3 p-5 text-sm">
          <div class="flex items-start gap-2">
            <CheckCircle2 size={15} class="mt-0.5 text-green-600" />
            <span>{$t("OAuthServer.edge_runtime_jwks")}</span>
          </div>
          <div class="flex items-start gap-2">
            <CheckCircle2 size={15} class="mt-0.5 text-green-600" />
            <span>{$t("OAuthServer.gotrue_proxy_note")}</span>
          </div>
          <div class="flex items-start gap-2">
            <AlertTriangle size={15} class="mt-0.5 text-amber-600" />
            <span>{$t("OAuthServer.functions_note")}</span>
          </div>
        </div>
      </section>
    </div>

    <section class="rounded-lg border bg-card">
      <div class="border-b px-5 py-4">
        <h2 class="font-semibold">{$t("OAuthServer.discovery_endpoints")}</h2>
      </div>
      <div class="divide-y">
        {#each endpointRows as row (row.label)}
          <div class="grid gap-2 px-5 py-3 text-sm md:grid-cols-[160px_1fr_auto]">
            <span class="font-medium">{row.label}</span>
            <code class="break-all rounded bg-muted/40 px-2 py-1 text-xs">{row.value}</code>
            <button class="rounded-md border p-2 hover:bg-muted/50" title={$t("Common.copy")} onclick={() => copyText(row.value)}>
              <Copy size={14} />
            </button>
          </div>
        {/each}
      </div>
    </section>

    <section class="rounded-lg border bg-card">
      <div class="flex items-center justify-between border-b px-5 py-4">
        <h2 class="font-semibold">OAuth Clients</h2>
        {#if clientsLoading}<Loader2 size={16} class="animate-spin text-muted-foreground" />{/if}
      </div>
      <div class="grid gap-4 p-5 xl:grid-cols-[0.8fr_1.2fr]">
        <div class="space-y-3">
          <input
            class="w-full rounded-md border bg-background px-3 py-2 text-sm"
            bind:value={clientName}
            placeholder={$t("OAuthServer.client_name_placeholder")}
          />
          <textarea
            class="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
            bind:value={redirectUrisText}
            placeholder={$t("OAuthServer.redirect_uri_placeholder")}
          ></textarea>
          <div class="grid gap-2 sm:grid-cols-2">
            <select class="rounded-md border bg-background px-3 py-2 text-sm" bind:value={clientType}>
              <option value="confidential">confidential</option>
              <option value="public">public</option>
            </select>
            <select class="rounded-md border bg-background px-3 py-2 text-sm" bind:value={authMethod} disabled={clientType === "public"}>
              <option value="client_secret_basic">client_secret_basic</option>
              <option value="client_secret_post">client_secret_post</option>
              <option value="none">none</option>
            </select>
          </div>
          <button
            class="inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted/50 disabled:opacity-50"
            onclick={createClient}
            disabled={saving || !statusData.enabled}
          >
            <Plus size={14} />
            {$t("OAuthServer.create_client")}
          </button>
        </div>

        <div class="overflow-hidden rounded-md border">
          {#if clients.length === 0}
            <div class="p-6 text-sm text-muted-foreground">{$t("OAuthServer.no_clients")}</div>
          {:else}
            <div class="divide-y">
              {#each clients as client ((client.client_id || client.id) ?? client.name)}
                <div class="grid gap-3 p-4 md:grid-cols-[1fr_auto]">
                  <div class="min-w-0">
                    <div class="font-medium">{client.client_name || client.name || client.client_id || client.id}</div>
                    <div class="mt-1 break-all font-mono text-xs text-muted-foreground">{client.client_id || client.id}</div>
                    <div class="mt-2 flex flex-wrap gap-1">
                      <span class="rounded bg-muted px-2 py-0.5 text-xs">{client.client_type || "confidential"}</span>
                      <span class="rounded bg-muted px-2 py-0.5 text-xs">{client.token_endpoint_auth_method || "client_secret_basic"}</span>
                    </div>
                    {#if client.redirect_uris?.length}
                      <div class="mt-2 space-y-1">
                        {#each client.redirect_uris as uri (uri)}
                          <div class="break-all font-mono text-xs text-muted-foreground">{uri}</div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                  <button
                    class="h-9 rounded-md border p-2 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    title={$t("Common.delete")}
                    onclick={() => deleteClient(client)}
                    disabled={saving}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</div>
