<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, Globe, Plus, Trash2, Shield, AlertTriangle, Copy, CheckCircle, XCircle, KeyRound, Save, Play } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface DomainInfo {
    custom_hostname: string;
    status: string;
  }

  interface CertificateSettings {
    mode: "lego" | "manual";
    challenge: "dns-01" | "http-01";
    email: string;
    dns_provider: string;
    dns_env: string[];
    domains: string[];
    auto_renew: boolean;
    status: string;
    certificate_id?: string;
    issued_at?: string;
    last_error?: string;
  }

  let newDomain = $state("");
  let showAdd = $state(false);
  let msg = $state<string | null>(null);
  let certMode = $state<"lego" | "manual">("lego");
  let certChallenge = $state<"dns-01" | "http-01">("dns-01");
  let certEmail = $state("");
  let certDnsProvider = $state("cloudflare");
  let certDnsEnv = $state("CLOUDFLARE_DNS_API_TOKEN");
  let certDomains = $state("");
  let manualCert = $state("");
  let manualKey = $state("");

  const projectRef = $derived(page.params.ref);
  const baseDomain = $derived(page.url?.hostname || "localhost");
  const queryClient = useQueryClient();

  const domainQuery = createQuery(() => ({
    queryKey: ["custom_hostname", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`);
      if (!res.ok) throw new Error("Failed to fetch custom hostname");
      const data = await res.json();
      return (data || null) as DomainInfo | null;
    },
    // Don't throw errors for 404s since it just means no custom domain
    retry: false,
  }));

  const domain = $derived(domainQuery.data || null);
  const isLoading = $derived(domainQuery.isPending);

  const certQuery = createQuery(() => ({
    queryKey: ["gateway_certificate", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/gateway/certificate`);
      if (!res.ok) throw new Error("Failed to fetch certificate settings");
      return (await res.json()) as CertificateSettings;
    },
    retry: false,
  }));

  const certSettings = $derived(certQuery.data || null);

  $effect(() => {
    if (!certSettings) return;
    certMode = certSettings.mode || "lego";
    certChallenge = certSettings.challenge || "dns-01";
    certEmail = certSettings.email || "";
    certDnsProvider = certSettings.dns_provider || "cloudflare";
    certDnsEnv = (certSettings.dns_env || []).join("\n") || "CLOUDFLARE_DNS_API_TOKEN";
    certDomains = (certSettings.domains || []).join("\n");
  });

  function certificatePayload() {
    return {
      mode: certMode,
      challenge: certChallenge,
      email: certEmail.trim(),
      dns_provider: certDnsProvider.trim(),
      dns_env: certDnsEnv.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean),
      domains: certDomains.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean),
      auto_renew: true,
    };
  }

  const addMutation = createMutation(() => ({
    mutationFn: async (hostname: string) => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom_hostname: hostname })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Unknown error");
      }
      return res.json();
    },
    onSuccess: () => {
      msg = "✅ 域名已添加，Kong 路由已更新";
      showAdd = false;
      newDomain = "";
      queryClient.invalidateQueries({ queryKey: ["custom_hostname", projectRef] });
      queryClient.invalidateQueries({ queryKey: ["gateway_certificate", projectRef] });
      setTimeout(() => msg = null, 5000);
    },
    onError: (err: unknown) => {
      msg = `❌ 添加失败: ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => msg = null, 5000);
    }
  }));

  function addDomain() {
    const d = newDomain.trim();
    if (!d) return;
    addMutation.mutate(d);
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`, { method: "DELETE" });
      if (!res.ok) throw new Error("删除失败");
      return res.json();
    },
    onSuccess: () => {
      msg = "✅ 域名已删除，Kong 路由已更新";
      queryClient.invalidateQueries({ queryKey: ["custom_hostname", projectRef] });
      queryClient.invalidateQueries({ queryKey: ["gateway_certificate", projectRef] });
      setTimeout(() => msg = null, 4000);
    },
    onError: (err: unknown) => {
      msg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => msg = null, 4000);
    }
  }));

  function deleteDomain() {
    if (!confirm("确定删除自定义域名？删除后将自动移除 Kong 路由绑定。")) return;
    deleteMutation.mutate();
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  const saveCertMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/gateway/certificate`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(certificatePayload()),
      });
      if (!res.ok) throw new Error("保存证书配置失败");
      return res.json();
    },
    onSuccess: () => {
      msg = "✅ 证书配置已保存";
      queryClient.invalidateQueries({ queryKey: ["gateway_certificate", projectRef] });
      setTimeout(() => msg = null, 4000);
    },
    onError: (err: unknown) => {
      msg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => msg = null, 5000);
    }
  }));

  const issueCertMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/gateway/certificate/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(certificatePayload()),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "签发证书失败");
      }
      return res.json();
    },
    onSuccess: () => {
      msg = "✅ 证书已签发并部署到 Kong";
      queryClient.invalidateQueries({ queryKey: ["gateway_certificate", projectRef] });
      setTimeout(() => msg = null, 5000);
    },
    onError: (err: unknown) => {
      msg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => msg = null, 7000);
    }
  }));

  const deployCertMutation = createMutation(() => ({
    mutationFn: async () => {
      const payload = certificatePayload();
      const res = await apiClient(`/v1/projects/${projectRef}/gateway/certificate/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cert: manualCert, key: manualKey, domains: payload.domains }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "部署证书失败");
      }
      return res.json();
    },
    onSuccess: () => {
      msg = "✅ 证书已部署到 Kong";
      manualCert = "";
      manualKey = "";
      queryClient.invalidateQueries({ queryKey: ["gateway_certificate", projectRef] });
      setTimeout(() => msg = null, 5000);
    },
    onError: (err: unknown) => {
      msg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => msg = null, 7000);
    }
  }));

  const certBusy = $derived(certQuery.isPending || saveCertMutation.isPending || issueCertMutation.isPending || deployCertMutation.isPending);
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">自定义域名</h1>
    <p class="text-sm text-muted-foreground mt-1">为项目 API 配置自定义域名和 Kong TLS 证书</p>
  </div>

  {#if msg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {msg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">{msg}</div>
  {/if}

  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <!-- Current Domain Status -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><Globe size={18} /> 当前域名配置</h2>
      </div>
      <div class="p-6 space-y-4">
        {#if domain && domain.custom_hostname}
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg bg-green-500/10 text-green-600 flex items-center justify-center">
                <CheckCircle size={20} />
              </div>
              <div>
                <span class="font-mono font-semibold">{domain.custom_hostname}</span>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-green-500/10 text-green-600 uppercase">{domain.status}</span>
                  <span class="text-[10px] text-muted-foreground">TLS 由 Kong certificates/SNI 管理</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button onclick={() => copyText(domain!.custom_hostname)} class="px-3 py-1.5 text-xs rounded-lg border hover:bg-muted/50 transition-colors flex items-center gap-1.5">
                <Copy size={12} /> 复制
              </button>
              <button onclick={deleteDomain} disabled={deleteMutation.isPending}
                class="px-3 py-1.5 text-xs rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                {#if deleteMutation.isPending}<Loader2 size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if} 删除
              </button>
            </div>
          </div>
        {:else}
          <div class="flex items-center gap-3 text-muted-foreground">
            <XCircle size={18} class="opacity-40" />
            <span class="text-sm">尚未配置自定义域名，使用默认域名 <span class="font-mono text-foreground">{projectRef}.api.{baseDomain}</span></span>
          </div>
          <button onclick={() => showAdd = true}
            class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
            <Plus size={14} /> 添加自定义域名
          </button>
        {/if}
      </div>
    </div>

    <!-- Add Domain Form -->
    {#if showAdd}
      <div class="rounded-xl border bg-card p-6 space-y-4">
        <h3 class="font-semibold text-sm">添加自定义域名</h3>
        <div>
          <span class="text-xs text-muted-foreground">域名</span>
          <input type="text" bind:value={newDomain} placeholder="api.yourdomain.com"
            class="w-full mt-1 px-3 py-2 text-sm font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>

        <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-4 space-y-2">
          <div class="flex items-center gap-2">
            <AlertTriangle size={14} class="text-amber-600" />
            <span class="text-xs font-semibold text-amber-700">添加前请先配置 DNS</span>
          </div>
          <div class="text-xs text-amber-700 space-y-1">
            <p>请在你的 DNS 提供商处添加以下 CNAME 记录：</p>
            <div class="bg-amber-500/10 rounded px-3 py-2 font-mono text-[11px] flex items-center justify-between">
              <span>{newDomain || 'api.yourdomain.com'} → {baseDomain}</span>
              <button onclick={() => copyText(`${newDomain || 'api.yourdomain.com'} CNAME ${baseDomain}`)} class="text-amber-700 hover:text-amber-900">
                <Copy size={12} />
              </button>
            </div>
            <p>DNS 生效后可在下方使用 lego 签发证书并部署到 Kong。</p>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button onclick={() => showAdd = false} class="px-4 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">取消</button>
          <button onclick={addDomain} disabled={addMutation.isPending || !newDomain.trim()}
            class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center gap-2">
            {#if addMutation.isPending}<Loader2 size={12} class="animate-spin" />{/if} 添加域名
          </button>
        </div>
      </div>
    {/if}

    <!-- Certificate Automation -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20 flex items-center justify-between gap-4">
        <h2 class="text-lg font-semibold flex items-center gap-2"><KeyRound size={18} /> Kong 证书</h2>
        {#if certSettings}
          <span class="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase {certSettings.status === 'deployed' ? 'bg-green-500/10 text-green-600' : certSettings.status === 'error' ? 'bg-red-500/10 text-red-600' : 'bg-muted text-muted-foreground'}">{certSettings.status}</span>
        {/if}
      </div>
      <div class="p-6 space-y-4">
        <div class="grid gap-4 md:grid-cols-3">
          <label class="space-y-1.5">
            <span class="text-xs text-muted-foreground">证书来源</span>
            <select bind:value={certMode} class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand">
              <option value="lego">lego 自动签发</option>
              <option value="manual">上传已有证书</option>
            </select>
          </label>

          <label class="space-y-1.5">
            <span class="text-xs text-muted-foreground">验证方式</span>
            <select bind:value={certChallenge} disabled={certMode === "manual"} class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50">
              <option value="dns-01">DNS-01</option>
              <option value="http-01">HTTP-01</option>
            </select>
          </label>

          <label class="space-y-1.5">
            <span class="text-xs text-muted-foreground">ACME 邮箱</span>
            <input bind:value={certEmail} disabled={certMode === "manual"} placeholder="admin@example.com"
              class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50" />
          </label>
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <label class="space-y-1.5">
            <span class="text-xs text-muted-foreground">证书域名</span>
            <textarea bind:value={certDomains} rows="4" placeholder="api.example.com&#10;studio.example.com"
              class="w-full px-3 py-2 text-sm font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"></textarea>
          </label>

          <div class="space-y-3">
            <label class="space-y-1.5 block">
              <span class="text-xs text-muted-foreground">DNS Provider</span>
              <input bind:value={certDnsProvider} disabled={certMode === "manual" || certChallenge !== "dns-01"} placeholder="cloudflare"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50" />
            </label>
            <label class="space-y-1.5 block">
              <span class="text-xs text-muted-foreground">DNS 凭证环境变量</span>
              <textarea bind:value={certDnsEnv} disabled={certMode === "manual" || certChallenge !== "dns-01"} rows="2" placeholder="CLOUDFLARE_DNS_API_TOKEN"
                class="w-full px-3 py-2 text-sm font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50"></textarea>
            </label>
          </div>
        </div>

        {#if certSettings?.last_error}
          <div class="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700">{certSettings.last_error}</div>
        {/if}

        {#if certMode === "manual"}
          <div class="grid gap-4 md:grid-cols-2">
            <label class="space-y-1.5">
              <span class="text-xs text-muted-foreground">fullchain.pem</span>
              <textarea bind:value={manualCert} rows="6" placeholder="-----BEGIN CERTIFICATE-----"
                class="w-full px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"></textarea>
            </label>
            <label class="space-y-1.5">
              <span class="text-xs text-muted-foreground">privkey.pem</span>
              <textarea bind:value={manualKey} rows="6" placeholder="-----BEGIN PRIVATE KEY-----"
                class="w-full px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"></textarea>
            </label>
          </div>
        {/if}

        <div class="flex flex-wrap justify-end gap-2">
          <button onclick={() => saveCertMutation.mutate()} disabled={certBusy}
            class="px-4 py-2 text-xs font-semibold rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50 flex items-center gap-2">
            {#if saveCertMutation.isPending}<Loader2 size={12} class="animate-spin" />{:else}<Save size={12} />{/if}
            保存配置
          </button>
          {#if certMode === "lego"}
            <button onclick={() => issueCertMutation.mutate()} disabled={certBusy || !certEmail.trim() || !certDomains.trim()}
              class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center gap-2">
              {#if issueCertMutation.isPending}<Loader2 size={12} class="animate-spin" />{:else}<Play size={12} />{/if}
              签发并部署
            </button>
          {:else}
            <button onclick={() => deployCertMutation.mutate()} disabled={certBusy || !manualCert.trim() || !manualKey.trim() || !certDomains.trim()}
              class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center gap-2">
              {#if deployCertMutation.isPending}<Loader2 size={12} class="animate-spin" />{:else}<Play size={12} />{/if}
              部署到 Kong
            </button>
          {/if}
        </div>
      </div>
    </div>

    <!-- Architecture Info -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-6 py-4 bg-muted/20">
        <h2 class="text-lg font-semibold flex items-center gap-2"><Shield size={18} /> 域名架构说明</h2>
      </div>
      <div class="p-6 space-y-3 text-xs text-muted-foreground">
        <div class="grid grid-cols-2 gap-4">
          <div class="rounded-lg border p-3 space-y-1">
            <span class="font-semibold text-foreground text-sm">API 端点</span>
            <p class="font-mono text-[11px]">{projectRef}.api.{baseDomain}</p>
            <p>所有 PostgREST/GoTrue/Storage/Realtime 请求经由 Kong 网关路由</p>
          </div>
          <div class="rounded-lg border p-3 space-y-1">
            <span class="font-semibold text-foreground text-sm">Studio 控制台</span>
            <p class="font-mono text-[11px]">studio-{projectRef}.{baseDomain}</p>
            <p>管理控制台的独立子域名入口</p>
          </div>
        </div>
        <div class="rounded-lg bg-blue-500/5 border border-blue-500/20 p-3 flex items-start gap-2">
          <Globe size={14} class="text-blue-600 mt-0.5 shrink-0" />
          <p class="text-blue-700">自定义域名直接绑定到 Kong 路由。证书由 lego 签发后通过 Kong Admin API 写入 certificates 和 SNI，也可以上传已有证书手动绑定。</p>
        </div>
      </div>
    </div>
  {/if}
</div>
