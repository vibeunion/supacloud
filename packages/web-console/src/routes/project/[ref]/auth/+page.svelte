<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Users, Loader2, Shield, MoreVertical, KeyRound, Link2, Mail, Timer, Clock, Webhook, Trash2 } from "lucide-svelte";

  const projectRef2 = $derived(page.params.ref);
  const authSubPages = $derived([
    { name: "用户", href: `/project/${projectRef2}/auth`, icon: Users, active: true },
    { name: "提供者", href: `/project/${projectRef2}/auth/providers`, icon: KeyRound, active: false },
    { name: "RLS 策略", href: `/project/${projectRef2}/auth/policies`, icon: Shield, active: false },
    { name: "URL 配置", href: `/project/${projectRef2}/auth/url-configuration`, icon: Link2, active: false },
    { name: "邮件模板", href: `/project/${projectRef2}/auth/templates`, icon: Mail, active: false },
    { name: "SMTP", href: `/project/${projectRef2}/auth/smtp`, icon: Mail, active: false },
    { name: "Hooks", href: `/project/${projectRef2}/auth/hooks`, icon: Webhook, active: false },
    { name: "会话", href: `/project/${projectRef2}/auth/sessions`, icon: Clock, active: false },
    { name: "MFA", href: `/project/${projectRef2}/auth/mfa`, icon: Shield, active: false },
    { name: "安全防护", href: `/project/${projectRef2}/auth/protection`, icon: Shield, active: false },
  ]);

  interface AuthUser {
    id: string;
    email: string;
    phone: string;
    created_at: string;
    last_sign_in_at: string;
    role: string;
    email_confirmed_at: string | null;
    raw_app_meta_data?: Record<string, unknown>;
    raw_user_meta_data?: Record<string, unknown>;
  }

  let users = $state<AuthUser[]>([]);
  let isLoading = $state(true);
  let error = $state<string | null>(null);

  let showAddUser = $state(false);
  let showInviteUser = $state(false);
  let newUserEmail = $state("");
  let newUserPassword = $state("");
  let newUserAutoConfirm = $state(true);
  let inviteEmail = $state("");
  let isSubmitting = $state(false);
  let submitMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);

  async function fetchUsers() {
    isLoading = true;
    error = null;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT id, email, phone, role, created_at, last_sign_in_at, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
                FROM auth.users ORDER BY created_at DESC LIMIT 100`
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      users = Array.isArray(data) ? data : data.rows || [];
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      isLoading = false;
    }
  }

  async function createUser() {
    if (!newUserEmail || !newUserPassword) return;
    isSubmitting = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newUserEmail,
          password: newUserPassword,
          email_confirm: newUserAutoConfirm
        })
      });
      if (res.ok) {
        showAddUser = false;
        newUserEmail = "";
        newUserPassword = "";
        submitMsg = "✅ 新用户创建成功";
        await fetchUsers();
      } else {
        const err = await res.json();
        submitMsg = `❌ 创建失败: ${err.error}`;
      }
    } catch (err: unknown) {
      submitMsg = `❌ 创建失败: ${(err instanceof Error ? err.message : String(err))}`;
    } finally {
      isSubmitting = false;
      setTimeout(() => submitMsg = null, 4000);
    }
  }

  async function inviteUser() {
    if (!inviteEmail) return;
    isSubmitting = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/users/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail })
      });
      if (res.ok) {
        showInviteUser = false;
        inviteEmail = "";
        submitMsg = "✅ 邀请发送成功";
        await fetchUsers();
      } else {
        const err = await res.json();
        submitMsg = `❌ 邀请失败: ${err.error}`;
      }
    } catch (err: unknown) {
      submitMsg = `❌ 邀请失败: ${(err instanceof Error ? err.message : String(err))}`;
    } finally {
      isSubmitting = false;
      setTimeout(() => submitMsg = null, 4000);
    }
  }

  async function deleteUser(id: string, email: string) {
    if (!confirm(`确定删除用户 ${email || id} 吗？此操作不可撤销。`)) return;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/users/${id}`, { method: "DELETE" });
      if (res.ok) {
        submitMsg = `用户已删除`;
        await fetchUsers();
      } else {
        const err = await res.json();
        submitMsg = `❌ 删除失败: ${err.error}`;
      }
    } catch (err: unknown) {
      submitMsg = `❌ 删除失败: ${(err instanceof Error ? err.message : String(err))}`;
    } finally {
      setTimeout(() => submitMsg = null, 4000);
    }
  }

  onMount(() => {
    fetchUsers();
  });

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return "-";
    return new Date(dateStr).toLocaleDateString();
  }

  function getProviders(user: AuthUser): string[] {
    if (user.raw_app_meta_data?.providers && Array.isArray(user.raw_app_meta_data.providers)) {
      return user.raw_app_meta_data.providers;
    }
    if (user.raw_app_meta_data?.provider) {
      return [String(user.raw_app_meta_data.provider)];
    }
    return ["email"];
  }

  function getInitial(email: string | undefined): string {
    if (!email) return "?";
    return email.charAt(0).toUpperCase();
  }
</script>

<div class="flex flex-col space-y-4">

  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <h1 class="text-2xl font-bold">{$t("Navigation.auth")}</h1>
      <span class="px-2 py-0.5 bg-brand/10 text-brand text-[10px] font-mono rounded-full uppercase tracking-wider">
        {users.length} {$t("Auth.users_count")}
      </span>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={() => showAddUser = true} class="flex items-center gap-2 px-4 py-1.5 border hover:bg-muted/50 text-xs font-semibold rounded-md transition-colors">
        创建用户
      </button>
      <button onclick={() => showInviteUser = true} class="flex items-center gap-2 px-4 py-1.5 bg-brand text-white text-xs font-semibold rounded-md hover:bg-brand/90 transition-colors">
        <Mail size={14} />
        {$t("Auth.invite_user")}
      </button>
    </div>
  </div>

  {#if submitMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {submitMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : submitMsg.startsWith('❌') ? 'bg-red-500/5 border-red-500/20 text-red-700' : 'bg-muted/50 border-border text-foreground'}">
      {submitMsg}
    </div>
  {/if}

  <!-- Modals -->
  {#if showAddUser || showInviteUser}
    <div class="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center">
      <div class="w-full max-w-md rounded-xl border bg-card shadow-lg flex flex-col">
        <div class="px-6 py-4 border-b flex items-center justify-between">
          <h2 class="text-lg font-semibold">{showAddUser ? "创建新用户" : "邀请新用户"}</h2>
          <button onclick={() => { showAddUser = false; showInviteUser = false; }} class="p-1 hover:bg-muted rounded-md transition-colors"><MoreVertical size={16} class="rotate-45" /></button>
        </div>
        <div class="p-6 space-y-4">
          {#if showAddUser}
            <div>
              <label for="a11y-routes-project--ref--auth--page-svelte-209" class="text-xs font-medium uppercase text-muted-foreground">邮箱</label>
              <input id="a11y-routes-project--ref--auth--page-svelte-209" type="email" bind:value={newUserEmail} class="mt-1.5 w-full flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand" placeholder="user@example.com" />
            </div>
            <div>
              <label for="a11y-routes-project--ref--auth--page-svelte-213" class="text-xs font-medium uppercase text-muted-foreground">密码</label>
              <input id="a11y-routes-project--ref--auth--page-svelte-213" type="password" bind:value={newUserPassword} class="mt-1.5 w-full flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand" placeholder="••••••••" />
            </div>
            <label class="flex items-center gap-2 text-sm mt-2">
              <input type="checkbox" bind:checked={newUserAutoConfirm} class="rounded border-input text-brand focus:ring-brand" />
              自动验证邮箱（Email Confirm）
            </label>
            <button onclick={createUser} disabled={isSubmitting || !newUserEmail || !newUserPassword} class="w-full mt-4 bg-brand text-white h-9 rounded-md text-sm font-semibold hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {#if isSubmitting}<Loader2 size={16} class="animate-spin" />{:else}创建用户{/if}
            </button>
          {:else}
            <div>
              <label for="a11y-routes-project--ref--auth--page-svelte-225" class="text-xs font-medium uppercase text-muted-foreground">邀请邮箱</label>
              <input id="a11y-routes-project--ref--auth--page-svelte-225" type="email" bind:value={inviteEmail} class="mt-1.5 w-full flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand" placeholder="user@example.com" />
            </div>
            <p class="text-xs text-muted-foreground mt-2">GoTrue 服务将发送一封带有魔术链接的邀请邮件至该邮箱。</p>
            <button onclick={inviteUser} disabled={isSubmitting || !inviteEmail} class="w-full mt-4 bg-brand text-white h-9 rounded-md text-sm font-semibold hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {#if isSubmitting}<Loader2 size={16} class="animate-spin" />{:else}<Mail size={16} /> 发送邀请邮件{/if}
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="h-full flex flex-col items-center justify-center text-muted-foreground gap-3 py-24">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("Auth.loading")}</p>
      </div>
    {:else if error}
      <div class="p-6">
        <div class="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">
          <strong>{$t("Auth.error")}:</strong> {error}
        </div>
      </div>
    {:else if users.length === 0}
      <div class="h-full flex flex-col items-center justify-center text-muted-foreground gap-3 py-24">
        <Shield size={48} class="opacity-20" />
        <p class="text-sm">{$t("Auth.no_users")}</p>
      </div>
    {:else}
      <table class="w-full text-left text-sm">
        <thead class="bg-muted/30 border-b">
          <tr>
            <th class="px-4 py-3 font-medium text-muted-foreground">User</th>
            <th class="px-4 py-3 font-medium text-muted-foreground">Providers</th>
            <th class="px-4 py-3 font-medium text-muted-foreground">{$t("Auth.phone")}</th>
            <th class="px-4 py-3 font-medium text-muted-foreground">{$t("Auth.role")}</th>
            <th class="px-4 py-3 font-medium text-muted-foreground">{$t("Auth.verified")}</th>
            <th class="px-4 py-3 font-medium text-muted-foreground">{$t("Auth.created")}</th>
            <th class="px-4 py-3 font-medium text-muted-foreground">{$t("Auth.last_sign_in")}</th>
            <th class="px-4 py-3 text-right"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border/30">
          {#each users as user}
            <tr class="hover:bg-muted/20 transition-colors group">
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-full bg-brand/10 text-brand flex items-center justify-center font-bold text-xs ring-1 ring-brand/20">
                    {getInitial(user.email)}
                  </div>
                  <div class="flex flex-col">
                    <span class="font-medium text-sm">{user.email || "-"}</span>
                    <span class="text-xs text-muted-foreground font-mono truncate max-w-[200px]" title={user.id}>{user.id}</span>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex gap-1 flex-wrap">
                  {#each getProviders(user) as provider}
                    <span class="px-2 py-0.5 bg-muted rounded text-[10px] uppercase font-medium tracking-wider text-muted-foreground border border-border/50">{provider}</span>
                  {/each}
                </div>
              </td>
              <td class="px-4 py-3 font-mono text-xs">{user.phone || "-"}</td>
              <td class="px-4 py-3">
                <span class="px-2 py-0.5 bg-brand/10 text-brand text-[10px] rounded-full">{user.role || "user"}</span>
              </td>
              <td class="px-4 py-3">
                {#if user.email_confirmed_at}
                  <span class="text-green-600 text-xs text-center block w-4">✓</span>
                {:else}
                  <span class="text-muted-foreground text-xs text-center block w-4">-</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-xs text-muted-foreground tabular-nums">{formatDate(user.created_at)}</td>
              <td class="px-4 py-3 text-xs text-muted-foreground tabular-nums">{formatDate(user.last_sign_in_at)}</td>
              <td class="px-4 py-3 text-right">
                <button onclick={() => deleteUser(user.id, user.email)} class="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded-md text-muted-foreground transition-colors opacity-0 group-hover:opacity-100" title="删除用户">
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
