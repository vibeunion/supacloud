<script lang="ts">
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
  import { Users, Shield, KeyRound, Link2, Mail, Clock, Webhook, BadgeCheck, ChevronDown, Fingerprint } from "lucide-svelte";

  type AuthRuntimeDescriptor = {
    project_ref: string;
    mode: "local" | "owner" | "shared";
    authority_project_ref: string;
    owner_project_ref: string | null;
    local_gotrue_enabled: boolean;
    public_auth_route: "local_gotrue" | "owner_proxy";
    user_management: "local" | "owner_only";
    configuration_management: "local" | "owner_only";
    local_membership_source: "project_database";
    realtime_auth_supported: boolean;
    owner_management_path: string | null;
  };

  const projectRef = $derived(page.params.ref ?? "");
  const currentPath = $derived(page.url.pathname);
  let authRuntime = $state.raw<AuthRuntimeDescriptor | null>(null);
  let authRuntimeError = $state<string | null>(null);
  let authRuntimeLoading = $state(true);

  const AUTH_GROUPS = [
    {
      labelKey: "AuthNav.users",
      tabs: [
        { name: "用户", path: "", route: "/project/[ref]/auth", icon: Users },
      ],
    },
    {
      labelKey: "AuthNav.sign_in",
      tabs: [
        { name: "提供者", path: "providers", route: "/project/[ref]/auth/providers", icon: KeyRound },
        { name: "Custom OAuth", path: "custom-providers", route: "/project/[ref]/auth/custom-providers", icon: KeyRound },
        { name: "Passkeys", path: "passkeys", route: "/project/[ref]/auth/passkeys", icon: Fingerprint },
        { name: "OAuth Server", path: "oauth-server", route: "/project/[ref]/auth/oauth-server", icon: BadgeCheck },
      ],
    },
    {
      labelKey: "AuthNav.security",
      tabs: [
        { name: "RLS 策略", path: "policies", route: "/project/[ref]/auth/policies", icon: Shield },
        { name: "会话", path: "sessions", route: "/project/[ref]/auth/sessions", icon: Clock },
        { name: "MFA", path: "mfa", route: "/project/[ref]/auth/mfa", icon: Shield },
        { name: "限频", path: "rate-limits", route: "/project/[ref]/auth/rate-limits", icon: Shield },
        { name: "安全防护", path: "protection", route: "/project/[ref]/auth/protection", icon: Shield },
      ],
    },
    {
      labelKey: "AuthNav.messaging",
      tabs: [
        { name: "URL 配置", path: "url-configuration", route: "/project/[ref]/auth/url-configuration", icon: Link2 },
        { name: "邮件模板", path: "templates", route: "/project/[ref]/auth/templates", icon: Mail },
        { name: "SMTP", path: "smtp", route: "/project/[ref]/auth/smtp", icon: Mail },
      ],
    },
    {
      labelKey: "AuthNav.advanced",
      tabs: [
        { name: "Hooks", path: "hooks", route: "/project/[ref]/auth/hooks", icon: Webhook },
      ],
    },
  ] as const;

  const visibleGroups = $derived(
    AUTH_GROUPS
      .map((group) => ({
        ...group,
        tabs: group.tabs.filter((tab) =>
          authRuntime?.mode === "local" || authRuntime?.mode === "owner" || tab.path === "policies"
        ),
      }))
      .filter((group) => group.tabs.length > 0),
  );
  const ownerManagedPage = $derived(
    authRuntime?.mode === "shared" && !currentPath.endsWith("/policies"),
  );

  onMount(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiClient(`/v1/projects/${projectRef}/auth/runtime`);
        const data = await response.json().catch(() => ({})) as Partial<AuthRuntimeDescriptor> & { message?: string };
        if (!response.ok) throw new Error(data.message || "无法读取认证运行模式");
        if (!cancelled) authRuntime = data as AuthRuntimeDescriptor;
      } catch (error: unknown) {
        if (!cancelled) {
          authRuntimeError = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (!cancelled) authRuntimeLoading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  function isActive(tabPath: string): boolean {
    const base = resolve("/project/[ref]/auth", { ref: projectRef });
    if (tabPath === "") return currentPath === base;
    return currentPath === `${base}/${tabPath}`;
  }

  function groupIsActive(tabs: readonly { path: string }[]) {
    return tabs.some((tab) => isActive(tab.path));
  }

  let { children } = $props();
</script>

<div class="h-full flex flex-col space-y-4">
  <!-- 按用户任务分组，避免十多个认证入口在窄屏横向溢出。 -->
  <div class="flex flex-wrap items-center gap-2 border-b border-border/30 px-1 pb-3">
    {#each visibleGroups as group (group.labelKey)}
      <details class="group/details relative">
        <summary class="flex cursor-pointer list-none items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors [&::-webkit-details-marker]:hidden {groupIsActive(group.tabs) ? 'border-brand/30 bg-brand/10 text-brand' : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'}">
          {$t(group.labelKey)}
          <ChevronDown class="h-3.5 w-3.5 transition-transform group-open/details:rotate-180" />
        </summary>
        <div class="absolute left-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl">
          {#each group.tabs as tab (tab.path)}
            {@const Icon = tab.icon}
            <a href={resolve(tab.route, { ref: projectRef })} class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors {isActive(tab.path) ? 'bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}">
              <Icon class="h-4 w-4" />
              {tab.name}
            </a>
          {/each}
        </div>
      </details>
    {/each}
  </div>

  {#if authRuntimeLoading}
    <div class="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
      正在确认项目认证运行模式…
    </div>
  {:else if authRuntimeError}
    <div class="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      无法确认认证运行模式：{authRuntimeError}。为避免误操作，认证管理面暂不可用，请刷新后重试。
    </div>
  {:else if authRuntime?.mode === "owner"}
    <div class="rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-4 text-sm text-blue-950 space-y-2">
      <p class="font-semibold">此项目是 SupAuth 认证权威</p>
      <p class="text-xs leading-5">
        此处的用户、OAuth、MFA、邮件和安全配置会影响所有使用 SupAuth 的从属项目。GoTrue 在本项目运行，并作为共享身份目录的唯一管理入口。
      </p>
    </div>
  {:else if authRuntime?.mode === "shared"}
    <div class="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-4 text-sm text-amber-950 space-y-2">
      <p class="font-semibold">此项目使用 SupAuth 共享认证</p>
      <p class="text-xs leading-5">
        本项目的公开认证请求会转发到 SupAuth，但本地 GoTrue 已停用。用户、OAuth、MFA、邮件和认证安全配置由权威项目
        <code class="font-mono">{authRuntime.authority_project_ref}</code> 统一管理；当前项目的本地数据库只负责业务数据、成员关系和 RLS。
      </p>
      <p class="text-xs leading-5 font-medium">
        shared 模式只接受权威项目签发的用户令牌；本项目的第三方 JWT 配置不会参与认证验证，请在权威项目统一规划认证来源。
      </p>
      {#if !authRuntime.realtime_auth_supported}
        <p class="text-xs leading-5 font-medium">
          当前官方 Realtime 租户仅支持单个 HS256 密钥，尚不能验证 SupAuth 的非对称用户令牌；共享模式下请暂不启用 Realtime 用户订阅。
        </p>
      {/if}
      {#if authRuntime.owner_management_path}
        <a
          class="inline-flex text-xs font-semibold text-amber-800 underline underline-offset-2"
          href={resolve("/project/[ref]/auth", { ref: authRuntime.authority_project_ref })}
        >
          前往权威项目管理认证
        </a>
      {/if}
    </div>
  {/if}

  <!-- Sub-page content -->
  <div class="flex-1 min-h-0 overflow-auto">
    {#if authRuntimeLoading}
      <div class="h-full flex items-center justify-center text-xs text-muted-foreground">正在加载…</div>
    {:else if authRuntimeError}
      <div class="h-full flex items-center justify-center text-xs text-muted-foreground">认证管理面已安全锁定。</div>
    {:else if ownerManagedPage}
      <div class="h-full flex items-center justify-center p-8">
        <div class="max-w-lg rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center space-y-3">
          <h1 class="text-lg font-semibold">认证设置由 SupAuth 权威项目管理</h1>
          <p class="text-xs leading-5 text-muted-foreground">
            为避免把共享用户误显示为本地用户，当前项目不提供本地 GoTrue 用户管理或认证配置写入。
            请在上方链接的权威项目中完成操作。
          </p>
        </div>
      </div>
    {:else}
      {@render children()}
    {/if}
  </div>
</div>
