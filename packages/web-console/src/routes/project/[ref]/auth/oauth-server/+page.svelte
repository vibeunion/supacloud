<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import {
    SupaCloudOAuthClientsClient, SupaCloudOAuthClientError,
    type SupaCloudOAuthClient, type SupaCloudOAuthClientCreate,
  } from "$supacloud/oauth-clients";
  import { readOAuthServer, migrateOAuthServerWithReadback, type OAuthServerStatus } from "./oauth-server-migration";
  import { AlertTriangle, Copy, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { t } from "svelte-i18n";

  type Scope = { ref: string; controller: AbortController; clients: SupaCloudOAuthClientsClient };
  const projectRef = $derived(page.params.ref ?? "");
  let scope: Scope | undefined;
  let clientsRevision = 0;
  let copyRevision = 0;
  let result = $state<OAuthServerStatus | null>(null);
  const statusData = $derived(result?.project_ref === projectRef ? result : null);
  let clients = $state<SupaCloudOAuthClient[]>([]);
  let clientState = $state<"unavailable" | "loading" | "ready" | "error">("unavailable");
  let loading = $state(true);
  let saving = $state(false);
  let copying = $state(false);
  let errorMessage = $state("");
  let mutationNotice = $state("");
  let mutationUncertain = $state(false);
  let partialWarning = $state("");
  let secret = $state<{ clientId: string; value: string } | null>(null);
  let allowDynamicRegistration = $state(false);
  let clientName = $state("");
  let redirectUrisText = $state("");
  let clientType = $state<"confidential" | "public">("confidential");
  let authMethod = $state<"client_secret_basic" | "client_secret_post">("client_secret_basic");
  const canManageClients = $derived(!!statusData?.enabled && clientState === "ready"
    && !loading && !saving && !secret && !mutationUncertain);
  const endpointRows = $derived(statusData ? [
    { label: $t("OAuthServer.endpoint_authorization"), value: statusData.authorization_endpoint },
    { label: $t("OAuthServer.endpoint_token"), value: statusData.token_endpoint },
    { label: $t("OAuthServer.endpoint_jwks"), value: statusData.jwks_url },
    { label: $t("OAuthServer.endpoint_discovery"), value: statusData.oauth_authorization_server_metadata_url },
    { label: $t("OAuthServer.endpoint_oidc"), value: statusData.discovery_url },
  ] : []);

  function current(owner: Scope): boolean {
    return scope === owner && owner.ref === projectRef && !owner.controller.signal.aborted;
  }
  function dismissSecret() {
    secret = null;
    copyRevision++;
    copying = false;
  }
  async function loadClients(owner: Scope) {
    if (!current(owner)) return;
    const revision = ++clientsRevision;
    clientState = "loading";
    clients = [];
    try {
      const value = await owner.clients.list({ signal: owner.controller.signal });
      if (current(owner) && revision === clientsRevision) {
        clients = value.clients;
        clientState = "ready";
      }
    } catch {
      if (current(owner) && revision === clientsRevision) clientState = "error";
    }
  }
  async function load(ref: string) {
    if (scope?.ref !== ref) partialWarning = "";
    scope?.controller.abort();
    scope = undefined;
    clientsRevision++;
    copyRevision++;
    loading = true;
    saving = false;
    copying = false;
    errorMessage = "";
    mutationNotice = "";
    mutationUncertain = false;
    result = null;
    clients = [];
    clientState = "unavailable";
    secret = null;
    clientName = "";
    redirectUrisText = "";
    clientType = "confidential";
    authMethod = "client_secret_basic";
    allowDynamicRegistration = false;
    let owner: Scope;
    try {
      owner = {
        ref, controller: new AbortController(),
        clients: new SupaCloudOAuthClientsClient({ projectRef: ref, managementApiUrl: "", sessionRequest: apiClient }),
      };
      scope = owner;
    } catch {
      errorMessage = "OAuth 配置暂时不可用。";
      loading = false;
      return;
    }
    try {
      const value = await readOAuthServer(ref, apiClient, owner.controller.signal);
      if (!current(owner)) return;
      result = value;
      allowDynamicRegistration = value.allow_dynamic_registration;
      loading = false;
      if (value.enabled) await loadClients(owner);
    } catch {
      if (current(owner)) errorMessage = "OAuth 配置暂时不可用。";
    } finally {
      if (current(owner)) loading = false;
    }
  }
  function refresh() {
    if (!loading && !saving && !secret) void load(projectRef);
  }
  function retryClients() {
    const owner = scope;
    if (owner && current(owner) && !saving && clientState !== "loading") void loadClients(owner);
  }
  async function migrate() {
    const owner = scope;
    if (!owner || !current(owner) || !statusData || loading || saving || secret) return;
    const before = { ...statusData };
    const allow = allowDynamicRegistration;
    copyRevision++;
    copying = false;
    saving = true;
    mutationNotice = "";
    clientState = "unavailable";
    clients = [];
    try {
      const value = await migrateOAuthServerWithReadback(before, allow, apiClient, owner.controller.signal);
      if (!current(owner)) return;
      result = value.status;
      allowDynamicRegistration = value.status.allow_dynamic_registration;
      partialWarning = value.outcome === "dependent_refresh_failed"
        ? "配置已保存，但依赖项目刷新失败或状态未知。尚未完成全部应用。" : "";
      if (partialWarning) toast.warning(partialWarning);
      else toast.success("OAuth 配置已保存。运行状态尚未验证。");
      await loadClients(owner);
    } catch {
      if (current(owner)) {
        result = null;
        errorMessage = "迁移结果未确认，配置可能已保存。请刷新核对，不要直接重复提交。";
      }
    } finally {
      if (current(owner)) saving = false;
    }
  }
  function clientFailure(error: unknown) {
    mutationUncertain = error instanceof SupaCloudOAuthClientError && error.mutationMayHaveApplied;
    mutationNotice = mutationUncertain
      ? "操作结果未确认，服务端可能已执行。请先刷新核对，不要直接重复提交。"
      : error instanceof SupaCloudOAuthClientError && error.code === "INVALID_OAUTH_CLIENT_INPUT"
        ? "客户端参数无效，请检查名称和回调地址。"
        : "客户端操作失败，请核对后重试。";
    toast.error(mutationNotice);
  }
  async function createClient() {
    const owner = scope;
    if (!owner || !current(owner) || !canManageClients) return;
    const form = { name: clientName, redirects: redirectUrisText, type: clientType, method: authMethod };
    const redirectUris = form.redirects.split("\n").map(value => value.trim()).filter(Boolean);
    if (!form.name.trim() || !redirectUris.length) {
      mutationNotice = "请填写客户端名称和回调地址。";
      return;
    }
    const body: SupaCloudOAuthClientCreate = form.type === "public"
      ? { client_name: form.name.trim(), redirect_uris: redirectUris, client_type: "public", token_endpoint_auth_method: "none" }
      : { client_name: form.name.trim(), redirect_uris: redirectUris, client_type: "confidential", token_endpoint_auth_method: form.method };
    saving = true;
    mutationNotice = "";
    try {
      const created = await owner.clients.create(body, { signal: owner.controller.signal });
      if (!current(owner)) return;
      if (created.client_type === "confidential") secret = { clientId: created.client_id, value: created.client_secret };
      if (clientName === form.name && redirectUrisText === form.redirects && clientType === form.type && authMethod === form.method) {
        clientName = "";
        redirectUrisText = "";
      }
      toast.success($t("OAuthServer.client_created"));
      await loadClients(owner);
    } catch (error) {
      if (current(owner)) clientFailure(error);
    } finally {
      if (current(owner)) saving = false;
    }
  }
  async function deleteClient(client: SupaCloudOAuthClient) {
    const owner = scope;
    if (!owner || !current(owner) || !canManageClients || !clients.some(value => value.client_id === client.client_id)) return;
    const id = client.client_id;
    if (!confirm($t("OAuthServer.client_delete_confirmation", { values: { name: client.client_name || id } }))) return;
    if (!current(owner) || !canManageClients) return;
    saving = true;
    mutationNotice = "";
    try {
      await owner.clients.delete(id, { signal: owner.controller.signal });
      if (!current(owner)) return;
      toast.success($t("OAuthServer.client_deleted"));
      await loadClients(owner);
    } catch (error) {
      if (current(owner)) clientFailure(error);
    } finally {
      if (current(owner)) saving = false;
    }
  }
  async function copyText(value: string) {
    const owner = scope;
    if (!owner || !current(owner) || copying
      || !(endpointRows.some(row => row.value === value) || secret?.value === value)) return;
    const revision = ++copyRevision;
    copying = true;
    try {
      await navigator.clipboard.writeText(value);
      if (current(owner) && revision === copyRevision) toast.success($t("Common.copied"));
    } catch {
      if (current(owner) && revision === copyRevision) toast.error($t("Common.copy_failed"));
    } finally {
      if (current(owner) && revision === copyRevision) copying = false;
    }
  }
  $effect(() => {
    const ref = projectRef;
    void load(ref);
    return () => { scope?.controller.abort(); clientsRevision++; copyRevision++; };
  });
</script>

<div class="flex flex-col gap-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">{$t("OAuthServer.title")}</h1>
      <p class="mt-1 text-sm text-muted-foreground">OAuth 配置与客户端</p>
    </div>
    <button class="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
      onclick={refresh} disabled={loading || saving || !!secret} aria-label="刷新 OAuth">
      <RefreshCw size={14} class={loading ? "animate-spin" : ""} />{$t("Common.refresh")}
    </button>
  </div>
  {#if loading || (!statusData && !errorMessage)}
    <div class="flex min-h-[240px] items-center justify-center" role="status" aria-label="加载 OAuth">
      <Loader2 size={28} class="animate-spin" />
    </div>
  {:else if errorMessage}
    <div class="border-l-2 border-destructive p-4 text-sm text-destructive" role="alert">{errorMessage}</div>
  {:else if statusData}
    <section class="border-y py-4">
      <div class="flex items-center gap-2">
        <ShieldCheck size={18} /><h2 class="font-semibold">配置状态</h2>
        <span class="ml-auto text-sm">{statusData.enabled ? "已配置启用" : "未配置启用"}</span>
      </div>
      <dl class="mt-4 grid gap-3 sm:grid-cols-3">
        <div><dt class="text-xs text-muted-foreground">{$t("OAuthServer.signing_algorithm")}</dt>
          <dd class="mt-1 font-mono text-sm">{statusData.signing_alg === "not_migrated" ? "未配置" : statusData.signing_alg}</dd></div>
        <div><dt class="text-xs text-muted-foreground">ID Token 签名</dt>
          <dd class="mt-1 text-sm">{statusData.oidc_id_token_ready ? "已配置" : "未配置"}</dd></div>
        <div><dt class="text-xs text-muted-foreground">{$t("OAuthServer.dynamic_registration")}</dt>
          <dd class="mt-1 text-sm">{statusData.allow_dynamic_registration ? $t("OAuthServer.allowed") : $t("OAuthServer.disabled")}</dd></div>
      </dl>
      <p class="mt-4 text-sm text-amber-800">运行状态未验证，配置状态不代表 GoTrue、JWKS 或 KMS 已生效。</p>
      {#if partialWarning}
        <div class="mt-3 flex items-start gap-2 text-sm text-amber-800" role="alert"><AlertTriangle size={16} class="shrink-0" />{partialWarning}</div>
      {/if}
      <div class="mt-4 flex flex-wrap items-center gap-4">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={allowDynamicRegistration} disabled={saving || !!secret} aria-label="允许动态注册" />
          {$t("OAuthServer.allow_dynamic_registration")}
        </label>
        <button class="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm text-brand-foreground disabled:opacity-50"
          onclick={migrate} disabled={saving || !!secret} aria-label="应用 OAuth 配置">
          {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<KeyRound size={14} />{/if}
          {statusData.enabled ? $t("OAuthServer.reapply_configuration") : $t("OAuthServer.enable")}
        </button>
      </div>
      <p class="mt-3 text-xs text-muted-foreground">{$t("OAuthServer.rls_warning")}</p>
    </section>

    <section>
      <h2 class="py-3 font-semibold">{$t("OAuthServer.discovery_endpoints")}</h2>
      <div class="divide-y border-y">
        {#each endpointRows as row (row.label)}
          <div class="grid items-start gap-2 py-3 text-sm md:grid-cols-[160px_minmax(0,1fr)_36px]">
            <span>{row.label}</span><code class="break-all text-xs">{row.value}</code>
            <button class="flex h-9 w-9 items-center justify-center rounded-md border disabled:opacity-50"
              title={`复制 ${row.label}`} disabled={copying} onclick={() => copyText(row.value)}><Copy size={14} /></button>
          </div>
        {/each}
      </div>
    </section>

    <section>
      <h2 class="py-3 font-semibold">OAuth Clients</h2>
      {#if mutationNotice}<p class="mb-3 text-sm text-destructive" role="alert">{mutationNotice}</p>{/if}
      {#if secret}
        <div class="mb-4 border-l-2 border-amber-600 p-3" role="status" aria-label="新客户端密钥">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="font-semibold">客户端密钥，仅本次返回</h3>
              <p class="mt-1 break-all font-mono text-xs">{secret.clientId}</p>
              <code class="mt-2 block break-all text-sm">{secret.value}</code>
            </div>
            <button class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border" title="关闭密钥" onclick={dismissSecret}><X size={16} /></button>
          </div>
          <button class="mt-3 flex h-9 w-9 items-center justify-center rounded-md border disabled:opacity-50"
            title="复制客户端密钥" disabled={copying} onclick={() => { if (secret) void copyText(secret.value); }}><Copy size={14} /></button>
        </div>
      {/if}
      {#if !statusData.enabled}
        <p class="py-4 text-sm text-muted-foreground">OAuth 尚未配置启用。</p>
      {:else}
        <div class="grid gap-6 xl:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.2fr)]">
          <fieldset class="min-w-0 space-y-3" disabled={!canManageClients}>
            <legend class="mb-3 text-sm font-medium">创建客户端</legend>
            <input class="w-full rounded-md border bg-background px-3 py-2 text-sm" bind:value={clientName}
              aria-label="客户端名称" placeholder={$t("OAuthServer.client_name_placeholder")} />
            <textarea class="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" bind:value={redirectUrisText}
              aria-label="回调地址" placeholder={$t("OAuthServer.redirect_uri_placeholder")}></textarea>
            <div class="grid gap-2">
              <select class="min-w-0 rounded-md border bg-background px-3 py-2 text-sm" bind:value={clientType} aria-label="客户端类型">
                <option value="confidential">confidential</option><option value="public">public</option>
              </select>
              {#if clientType === "public"}
                <select class="min-w-0 rounded-md border bg-background px-3 py-2 text-sm" disabled aria-label="客户端认证方式">
                  <option value="none">none</option>
                </select>
              {:else}
                <select class="min-w-0 rounded-md border bg-background px-3 py-2 text-sm" bind:value={authMethod}
                  disabled={!canManageClients} aria-label="客户端认证方式">
                  <option value="client_secret_basic">client_secret_basic</option><option value="client_secret_post">client_secret_post</option>
                </select>
              {/if}
            </div>
            <button class="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
              onclick={createClient} disabled={!canManageClients} aria-label="创建客户端">
              <Plus size={14} />{$t("OAuthServer.create_client")}
            </button>
          </fieldset>
          <div class="min-w-0 border-y">
            {#if clientState === "loading"}
              <div class="flex items-center gap-2 py-6 text-sm" role="status" aria-label="加载客户端"><Loader2 size={16} class="animate-spin" />正在读取客户端</div>
            {:else if clientState === "error"}
              <div class="py-4 text-sm" role="alert">
                <p>客户端列表暂时不可用。</p>
                <button class="mt-2 inline-flex items-center gap-2 rounded-md border px-3 py-2 disabled:opacity-50"
                  onclick={retryClients} disabled={saving} aria-label="重试客户端"><RefreshCw size={14} />重试</button>
              </div>
            {:else if clientState === "ready" && clients.length === 0}
              <p class="py-6 text-sm text-muted-foreground">{$t("OAuthServer.no_clients")}</p>
            {:else if clientState === "ready"}
              <div class="divide-y">
                {#each clients as client (client.client_id)}
                  <div class="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_36px]">
                    <div class="min-w-0">
                      <div class="break-words font-medium">{client.client_name || "未命名客户端"}</div>
                      <div class="mt-1 break-all font-mono text-xs text-muted-foreground">{client.client_id}</div>
                      <div class="mt-2 flex flex-wrap gap-2 text-xs"><span>{client.client_type}</span>
                        <span>{client.token_endpoint_auth_method ?? "认证方式未返回"}</span></div>
                      {#each client.redirect_uris ?? [] as uri (uri)}
                        <div class="mt-2 break-all font-mono text-xs text-muted-foreground">{uri}</div>
                      {/each}
                    </div>
                    <button class="flex h-9 w-9 items-center justify-center rounded-md border text-destructive disabled:opacity-50"
                      title={$t("Common.delete")} onclick={() => deleteClient(client)} disabled={!canManageClients}><Trash2 size={14} /></button>
                  </div>
                {/each}
              </div>
            {:else}<p class="py-4 text-sm text-muted-foreground">客户端状态尚未确认。</p>{/if}
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>
