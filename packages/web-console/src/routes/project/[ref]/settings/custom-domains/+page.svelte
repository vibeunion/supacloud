<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, Globe, Plus, Trash2, Shield, AlertTriangle, ExternalLink, Copy, CheckCircle, XCircle } from "lucide-svelte";

  interface DomainInfo {
    custom_hostname: string;
    status: string;
  }

  let domain = $state<DomainInfo | null>(null);
  let isLoading = $state(true);
  let newDomain = $state("");
  let showAdd = $state(false);
  let saving = $state(false);
  let deleting = $state(false);
  let msg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);
  const baseDomain = $derived(page.url?.hostname || "localhost");

  async function fetchDomain() {
    isLoading = true;
    try {
      const res = await fetch(`/v1/projects/${projectRef}/custom-hostname`);
      if (res.ok) {
        domain = await res.json();
      }
    } catch (err) {
      console.error("Failed to fetch custom domain:", err);
    } finally {
      isLoading = false;
    }
  }

  async function addDomain() {
    if (!newDomain.trim()) return;
    saving = true;
    try {
      const res = await fetch(`/v1/projects/${projectRef}/custom-hostname`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom_hostname: newDomain.trim() })
      });
      if (res.ok) {
        msg = "✅ 域名已添加，Angie 配置已生成并自动申请 SSL 证书";
        showAdd = false;
        newDomain = "";
        await fetchDomain();
      } else {
        const err = await res.json();
        msg = `❌ 添加失败: ${err.error || "Unknown error"}`;
      }
    } catch (err: any) {
      msg = `❌ ${err.message}`;
    } finally {
      saving = false;
      setTimeout(() => msg = null, 5000);
    }
  }

  async function deleteDomain() {
    if (!confirm("确定删除自定义域名？删除后将自动移除 Angie 配置和 SSL 证书。")) return;
    deleting = true;
    try {
      const res = await fetch(`/v1/projects/${projectRef}/custom-hostname`, { method: "DELETE" });
      if (res.ok) {
        msg = "✅ 域名已删除，Angie 配置已移除";
        await fetchDomain();
      } else {
        msg = "❌ 删除失败";
      }
    } catch (err: any) {
      msg = `❌ ${err.message}`;
    } finally {
      deleting = false;
      setTimeout(() => msg = null, 4000);
    }
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  onMount(() => { fetchDomain(); });
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">自定义域名</h1>
    <p class="text-sm text-muted-foreground mt-1">为你的项目 API 配置自定义域名，系统将自动通过 Angie + ACME 生成 SSL 证书</p>
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
                  <span class="text-[10px] text-muted-foreground">SSL 由 Angie ACME 自动管理</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button onclick={() => copyText(domain!.custom_hostname)} class="px-3 py-1.5 text-xs rounded-lg border hover:bg-muted/50 transition-colors flex items-center gap-1.5">
                <Copy size={12} /> 复制
              </button>
              <button onclick={deleteDomain} disabled={deleting}
                class="px-3 py-1.5 text-xs rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                {#if deleting}<Loader2 size={12} class="animate-spin" />{:else}<Trash2 size={12} />{/if} 删除
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
            <p>DNS 记录生效后，系统将自动通过 Let's Encrypt 签发 SSL 证书。</p>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button onclick={() => showAdd = false} class="px-4 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">取消</button>
          <button onclick={addDomain} disabled={saving || !newDomain.trim()}
            class="px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center gap-2">
            {#if saving}<Loader2 size={12} class="animate-spin" />{/if} 添加域名
          </button>
        </div>
      </div>
    {/if}

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
          <p class="text-blue-700">自定义域名通过 <b>Angie</b>（Nginx 增强分支）作为反向代理，自动将流量路由到 Kong API 网关。SSL 证书通过 ACME 协议自动签发和续期。</p>
        </div>
      </div>
    </div>
  {/if}
</div>
