<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { Clock, KeyRound, Loader2, Plus, ShieldOff } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  type AllowedNetworks = {
    allowed_cidrs?: Array<{ cidr: string }>;
    allowed_cidrs_v6?: Array<{ cidr: string }>;
  };
  type Rule = {
    user_id: string;
    role: string;
    expires_at: number | string;
    allowed_networks?: AllowedNetworks;
    branches_only?: boolean;
    inherited_from?: string;
  };
  type Credential = {
    id: string;
    login_role: string;
    role: string;
    password: string;
    expires_at: number;
    connection_string: string;
  };

  const projectRef = $derived(page.params.ref);
  let accessState = $state<"enabled" | "disabled">("disabled");
  let rules = $state.raw<Rule[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let userId = $state("");
  let role = $state("app_reader");
  let ttlDays = $state(1);
  let ipv4Cidrs = $state("");
  let ipv6Cidrs = $state("");
  let branchesOnly = $state(false);
  let credential = $state<Credential | null>(null);

  async function request(path: string, init?: RequestInit) {
    const response = await apiClient(`/v1/projects/${projectRef}/database${path}`, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "请求失败");
    return body;
  }

  async function load() {
    loading = true;
    try {
      const [stateBody, rulesBody] = await Promise.all([request("/jit-access"), request("/jit")]);
      accessState = stateBody.state;
      rules = rulesBody.user_roles || [];
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法加载临时访问设置");
    } finally {
      loading = false;
    }
  }

  async function toggleAccess() {
    saving = true;
    try {
      const next = accessState === "enabled" ? "disabled" : "enabled";
      await request("/jit-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: next }),
      });
      accessState = next;
      if (next === "disabled") credential = null;
      toast.success(next === "enabled" ? "临时数据库访问已启用" : "临时数据库访问已禁用，现有凭据已撤销");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新失败");
    } finally {
      saving = false;
    }
  }

  async function addRule() {
    if (!userId || !role) return;
    saving = true;
    try {
      const expiresAt = Date.now() + Math.max(1, Math.min(90, ttlDays)) * 86_400_000;
      const existing = rules.filter((item) => item.user_id === userId && item.role !== role);
      const splitCidrs = (value: string) => value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
      const allowedNetworks = {
        allowed_cidrs: splitCidrs(ipv4Cidrs).map((cidr) => ({ cidr })),
        allowed_cidrs_v6: splitCidrs(ipv6Cidrs).map((cidr) => ({ cidr })),
      };
      await request("/jit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          user_roles: [
            ...existing.map((item) => ({
              role: item.role,
              expires_at: Number(item.expires_at),
              allowed_networks: item.allowed_networks,
              branches_only: item.branches_only,
            })),
            { role, expires_at: expiresAt, allowed_networks: allowedNetworks, branches_only: branchesOnly },
          ],
        }),
      });
      await load();
      toast.success("临时访问规则已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存规则失败");
    } finally {
      saving = false;
    }
  }

  async function issue(rule: Rule) {
    saving = true;
    try {
      credential = await request("/jit/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: rule.user_id, role: rule.role }),
      }) as Credential;
      toast.success("短期凭据已签发；密码仅显示本次");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "签发凭据失败");
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<svelte:head><title>临时数据库访问 · SupaCloud</title></svelte:head>

<div class="space-y-5 pb-10">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <div class="flex items-center gap-2"><KeyRound size={22} class="text-brand" /><h1 class="text-2xl font-bold">临时数据库访问</h1></div>
      <p class="mt-1 text-sm text-muted-foreground">给项目成员授权既有 PostgreSQL 角色，并签发自动过期的独立登录凭据。</p>
    </div>
    <button onclick={toggleAccess} disabled={loading || saving} class={`inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-medium ${accessState === "enabled" ? "border bg-background" : "bg-brand text-white"}`}>
      {#if saving}<Loader2 size={15} class="animate-spin" />{:else if accessState === "enabled"}<ShieldOff size={15} />{:else}<KeyRound size={15} />{/if}
      {accessState === "enabled" ? "禁用并撤销凭据" : "启用临时访问"}
    </button>
  </div>

  <div class={`rounded-lg border p-3 text-xs ${accessState === "enabled" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700" : "bg-muted/30 text-muted-foreground"}`}>
    状态：{accessState === "enabled" ? "已启用" : "已禁用"}。凭据使用独立 login role，不修改目标角色的长期密码；禁用功能会终止会话并撤销所有未过期凭据。
  </div>

  {#if accessState === "enabled"}
    <section class="space-y-4 rounded-xl border bg-card p-5">
      <h2 class="font-semibold">新增或更新规则</h2>
      <div class="grid gap-3 md:grid-cols-[1fr_1fr_140px_auto]">
        <label class="space-y-1 text-xs"><span>项目成员 ID</span><input bind:value={userId} class="h-9 w-full rounded-md border bg-background px-3 font-mono" placeholder="GoTrue user UUID" /></label>
        <label class="space-y-1 text-xs"><span>PostgreSQL 角色</span><input bind:value={role} class="h-9 w-full rounded-md border bg-background px-3 font-mono" placeholder="postgres / app_reader" /></label>
        <label class="space-y-1 text-xs"><span>有效天数（1–90）</span><input bind:value={ttlDays} type="number" min="1" max="90" class="h-9 w-full rounded-md border bg-background px-3" /></label>
        <button onclick={addRule} disabled={saving || !userId || !role} class="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white disabled:opacity-50"><Plus size={15} />保存</button>
      </div>
      <div class="grid gap-3 md:grid-cols-2">
        <label class="space-y-1 text-xs"><span>允许的 IPv4 CIDR（逗号或空格分隔）</span><input bind:value={ipv4Cidrs} class="h-9 w-full rounded-md border bg-background px-3 font-mono" placeholder="203.0.113.7/32" /></label>
        <label class="space-y-1 text-xs"><span>允许的 IPv6 CIDR（逗号或空格分隔）</span><input bind:value={ipv6Cidrs} class="h-9 w-full rounded-md border bg-background px-3 font-mono" placeholder="2001:db8::/32" /></label>
      </div>
      <label class="flex items-center gap-2 text-xs"><input bind:checked={branchesOnly} type="checkbox" class="size-4 rounded border" /><span>仅允许分支项目使用此规则</span></label>
      <p class="text-xs text-muted-foreground">设置 CIDR 后，凭据会使用独立 JIT TCP 入口；来源地址未命中白名单时，流量不会到达 PostgreSQL。项目成员必须处于 active 状态。</p>
    </section>
  {/if}

  <section class="overflow-hidden rounded-xl border bg-card">
    <div class="border-b px-5 py-4"><h2 class="font-semibold">访问规则</h2></div>
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 size={16} class="animate-spin" />加载中</div>
    {:else if rules.length === 0}
      <div class="py-12 text-center text-sm text-muted-foreground">暂无临时访问规则</div>
    {:else}
      <div class="divide-y">
        {#each rules as item (`${item.user_id}:${item.role}`)}
          <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div>
              <code class="text-xs font-semibold">{item.user_id}</code>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span class="rounded bg-brand/10 px-2 py-0.5 font-mono text-brand">{item.role}</span>
                <Clock size={12} />{new Date(Number(item.expires_at)).toLocaleString()}
                {#if item.branches_only}<span class="rounded bg-muted px-2 py-0.5">仅分支</span>{/if}
                {#if item.inherited_from}<span class="rounded bg-muted px-2 py-0.5">继承自 {item.inherited_from}</span>{/if}
              </div>
              {#if item.allowed_networks}
                <div class="mt-2 font-mono text-[11px] text-muted-foreground">
                  {[...(item.allowed_networks.allowed_cidrs || []), ...(item.allowed_networks.allowed_cidrs_v6 || [])].map((entry) => entry.cidr).join(", ") || "任意来源"}
                </div>
              {/if}
            </div>
            <button onclick={() => issue(item)} disabled={saving || accessState !== "enabled"} class="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50">签发凭据</button>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if credential}
    <section class="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div><h2 class="font-semibold text-amber-800">一次性凭据</h2><p class="mt-1 text-xs text-amber-700">关闭或刷新页面后不会再次显示密码。请通过安全渠道交付。</p></div>
      <div class="grid gap-3 text-xs md:grid-cols-2"><div><span class="text-muted-foreground">登录角色</span><pre class="mt-1 overflow-auto rounded bg-background p-3">{credential.login_role}</pre></div><div><span class="text-muted-foreground">目标角色</span><pre class="mt-1 overflow-auto rounded bg-background p-3">{credential.role}</pre></div></div>
      <div><span class="text-xs text-muted-foreground">连接字符串</span><pre class="mt-1 overflow-auto rounded bg-background p-3 text-xs">{credential.connection_string}</pre></div>
    </section>
  {/if}
</div>
