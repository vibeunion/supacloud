<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
  import { KeyRound, Loader2, Pencil, Plus, Save, Trash2, X } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  type Provider = {
    id?: string;
    provider_type: "oauth2" | "oidc";
    identifier: string;
    name: string;
    client_id: string;
    enabled: boolean;
    scopes?: string[];
    issuer?: string;
    authorization_url?: string;
    token_url?: string;
    userinfo_url?: string;
    pkce_enabled?: boolean;
  };

  const projectRef = $derived(page.params.ref ?? "");
  let providers = $state.raw<Provider[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let showForm = $state(false);
  let editingIdentifier = $state<string | null>(null);
  let providerType = $state<"oauth2" | "oidc">("oidc");
  let identifier = $state("");
  let name = $state("");
  let clientId = $state("");
  let clientSecret = $state("");
  let scopesText = $state("openid, email, profile");
  let issuer = $state("");
  let authorizationUrl = $state("");
  let tokenUrl = $state("");
  let userinfoUrl = $state("");
  let enabled = $state(true);
  let pkceEnabled = $state(true);

  function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  async function responseMessage(response: Response, fallback: string): Promise<string> {
    const payload = record(await response.json().catch(() => null));
    return typeof payload.message === "string" && payload.message.trim() ? payload.message : fallback;
  }

  async function loadProviders() {
    loading = true;
    try {
      const response = await apiClient(`/v1/projects/${projectRef}/auth/custom-providers`);
      if (!response.ok) throw new Error(await responseMessage(response, $t("CustomProviders.load_failed")));
      const payload = record(await response.json());
      providers = Array.isArray(payload.providers) ? payload.providers as Provider[] : [];
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : $t("CustomProviders.load_failed"));
    } finally {
      loading = false;
    }
  }

  function resetForm() {
    editingIdentifier = null;
    providerType = "oidc";
    identifier = "";
    name = "";
    clientId = "";
    clientSecret = "";
    scopesText = "openid, email, profile";
    issuer = "";
    authorizationUrl = "";
    tokenUrl = "";
    userinfoUrl = "";
    enabled = true;
    pkceEnabled = true;
  }

  function openCreate() {
    resetForm();
    showForm = true;
  }

  function openEdit(provider: Provider) {
    editingIdentifier = provider.identifier;
    providerType = provider.provider_type;
    identifier = provider.identifier;
    name = provider.name;
    clientId = provider.client_id;
    clientSecret = "";
    scopesText = provider.scopes?.join(", ") ?? "";
    issuer = provider.issuer ?? "";
    authorizationUrl = provider.authorization_url ?? "";
    tokenUrl = provider.token_url ?? "";
    userinfoUrl = provider.userinfo_url ?? "";
    enabled = provider.enabled;
    pkceEnabled = provider.pkce_enabled ?? true;
    showForm = true;
  }

  function normalizedIdentifier(): string {
    const value = identifier.trim();
    return value.startsWith("custom:") ? value : `custom:${value}`;
  }

  function requestBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      provider_type: providerType,
      identifier: normalizedIdentifier(),
      name: name.trim(),
      client_id: clientId.trim(),
      scopes: scopesText.split(",").map((scope) => scope.trim()).filter(Boolean),
      enabled,
      pkce_enabled: pkceEnabled,
    };
    if (clientSecret) body.client_secret = clientSecret;
    if (providerType === "oidc") body.issuer = issuer.trim();
    else Object.assign(body, {
      authorization_url: authorizationUrl.trim(),
      token_url: tokenUrl.trim(),
      userinfo_url: userinfoUrl.trim(),
    });
    return body;
  }

  async function saveProvider() {
    if (!identifier.trim() || !name.trim() || !clientId.trim() || (!editingIdentifier && !clientSecret)) {
      toast.error($t("CustomProviders.required_fields"));
      return;
    }
    saving = true;
    try {
      const path = editingIdentifier
        ? `/v1/projects/${projectRef}/auth/custom-providers/${encodeURIComponent(editingIdentifier)}`
        : `/v1/projects/${projectRef}/auth/custom-providers`;
      const response = await apiClient(path, {
        method: editingIdentifier ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody()),
      });
      if (!response.ok) throw new Error(await responseMessage(response, $t("CustomProviders.save_failed")));
      toast.success($t(editingIdentifier ? "CustomProviders.updated" : "CustomProviders.created"));
      showForm = false;
      resetForm();
      await loadProviders();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : $t("CustomProviders.save_failed"));
    } finally {
      saving = false;
    }
  }

  async function deleteProvider(provider: Provider) {
    if (!confirm($t("CustomProviders.delete_confirmation", { values: { name: provider.name, identifier: provider.identifier } }))) return;
    const response = await apiClient(
      `/v1/projects/${projectRef}/auth/custom-providers/${encodeURIComponent(provider.identifier)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      toast.error(await responseMessage(response, $t("CustomProviders.delete_failed")));
      return;
    }
    toast.success($t("CustomProviders.deleted"));
    await loadProviders();
  }

  onMount(() => { void loadProviders(); });
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">{$t("CustomProviders.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("CustomProviders.subtitle")}</p>
    </div>
    <button onclick={openCreate} class="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white">
      <Plus size={14} /> {$t("CustomProviders.create")}
    </button>
  </div>

  {#if showForm}
    <div class="rounded-xl border bg-card p-5 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">{editingIdentifier ? $t("CustomProviders.edit_title", { values: { identifier: editingIdentifier } }) : $t("CustomProviders.new_title")}</h2>
        <button onclick={() => { showForm = false; resetForm(); }} class="rounded p-1 text-muted-foreground hover:bg-muted"><X size={16} /></button>
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        <label class="text-xs font-medium space-y-1">{$t("CustomProviders.protocol")}
          <select bind:value={providerType} disabled={Boolean(editingIdentifier)} class="w-full rounded-lg border bg-background px-3 py-2">
            <option value="oidc">OpenID Connect</option><option value="oauth2">OAuth 2.0</option>
          </select>
        </label>
        <label class="text-xs font-medium space-y-1">{$t("CustomProviders.identifier")}
          <input bind:value={identifier} disabled={Boolean(editingIdentifier)} placeholder="custom:workos" class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono" />
        </label>
        <label class="text-xs font-medium space-y-1">{$t("CustomProviders.display_name")}
          <input bind:value={name} placeholder="WorkOS" class="w-full rounded-lg border bg-muted/20 px-3 py-2" />
        </label>
        <label class="text-xs font-medium space-y-1">Client ID
          <input bind:value={clientId} class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono" />
        </label>
        <label class="text-xs font-medium space-y-1">Client Secret {editingIdentifier ? $t("CustomProviders.keep_existing_hint") : ""}
          <input type="password" bind:value={clientSecret} class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono" />
        </label>
        <label class="text-xs font-medium space-y-1">{$t("CustomProviders.scopes")}
          <input bind:value={scopesText} class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono" />
        </label>
        {#if providerType === "oidc"}
          <label class="md:col-span-2 text-xs font-medium space-y-1">Issuer
            <input bind:value={issuer} placeholder="https://id.example.com" class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono" />
          </label>
        {:else}
          <label class="text-xs font-medium space-y-1">Authorization URL<input bind:value={authorizationUrl} class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono" /></label>
          <label class="text-xs font-medium space-y-1">Token URL<input bind:value={tokenUrl} class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono" /></label>
          <label class="md:col-span-2 text-xs font-medium space-y-1">UserInfo URL<input bind:value={userinfoUrl} class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono" /></label>
        {/if}
      </div>
      <div class="flex items-center gap-6 text-xs">
        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={enabled} /> {$t("CustomProviders.enabled")}</label>
        <label class="flex items-center gap-2"><input type="checkbox" bind:checked={pkceEnabled} /> PKCE</label>
      </div>
      <div class="flex justify-end">
        <button onclick={saveProvider} disabled={saving} class="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
          {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if} {$t("Common.save")}
        </button>
      </div>
    </div>
  {/if}

  <div class="rounded-xl border bg-card overflow-hidden">
    {#if loading}
      <div class="py-24 flex justify-center"><Loader2 class="animate-spin text-brand" /></div>
    {:else if providers.length === 0}
      <div class="py-20 flex flex-col items-center gap-3 text-muted-foreground"><KeyRound size={32} /><p class="text-sm">{$t("CustomProviders.empty")}</p></div>
    {:else}
      <div class="divide-y">
        {#each providers as provider (provider.identifier)}
          <div class="flex items-center justify-between gap-4 px-5 py-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2"><span class="font-semibold">{provider.name}</span><span class="rounded bg-muted px-2 py-0.5 text-[10px] uppercase">{provider.provider_type}</span>{#if provider.enabled}<span class="text-xs text-green-600">{$t("CustomProviders.enabled")}</span>{/if}</div>
              <p class="mt-1 truncate font-mono text-xs text-muted-foreground">{provider.identifier} · {provider.client_id}</p>
            </div>
            <div class="flex items-center gap-1">
              <button onclick={() => openEdit(provider)} aria-label={$t("CustomProviders.edit_aria", { values: { name: provider.name } })} class="rounded p-2 text-muted-foreground hover:bg-muted"><Pencil size={14} /></button>
              <button onclick={() => deleteProvider(provider)} aria-label={$t("CustomProviders.delete_aria", { values: { name: provider.name } })} class="rounded p-2 text-muted-foreground hover:bg-red-500/10 hover:text-red-600"><Trash2 size={14} /></button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
