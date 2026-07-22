<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { untrack } from "svelte";
  import { Loader2, Webhook, Zap, AlertTriangle, Save, ChevronDown, ChevronUp } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface AuthHook {
    id: string;
    name: string;
    description: string;
    hook_type: string;
    expanded: boolean;
    enabledKey: string;
    uriKey: string;
    enabled: boolean;
    uri: string;
  }

  const HOOKS_DEF = [
    { id: "custom_access_token", name: "Custom Access Token", description: "在签发 JWT 前修改 Access Token 的 claims", hook_type: "pg_function", enabledKey: "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED", uriKey: "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI" },
    { id: "mfa_verification", name: "MFA Verification Attempt", description: "在 MFA 验证尝试时触发自定义逻辑", hook_type: "pg_function", enabledKey: "GOTRUE_HOOK_MFA_VERIFICATION_ATTEMPT_ENABLED", uriKey: "GOTRUE_HOOK_MFA_VERIFICATION_ATTEMPT_URI" },
    { id: "password_verification", name: "Password Verification Attempt", description: "自定义密码验证逻辑（如接入外部密码策略）", hook_type: "pg_function", enabledKey: "GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED", uriKey: "GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI" },
    { id: "send_sms", name: "Send SMS", description: "自定义短信发送逻辑（替代内置 SMS 提供商）", hook_type: "http", enabledKey: "GOTRUE_HOOK_SEND_SMS_ENABLED", uriKey: "GOTRUE_HOOK_SEND_SMS_URI" },
    { id: "send_email", name: "Send Email", description: "自定义邮件发送逻辑（替代内置邮件服务）", hook_type: "http", enabledKey: "GOTRUE_HOOK_SEND_EMAIL_ENABLED", uriKey: "GOTRUE_HOOK_SEND_EMAIL_URI" },
  ];

  let saveMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const configQuery = createQuery(() => ({
    queryKey: ["auth_config", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`);
      if (!res.ok) throw new Error("Failed to load config");
      return await res.json();
    }
  }));

  let hooks = $state<AuthHook[]>([]);

  $effect(() => {
    if (configQuery.data) {
      const config = configQuery.data;
      const previousHooks = untrack(() => hooks);
      hooks = HOOKS_DEF.map(h => {
        const existing = previousHooks.find(e => e.id === h.id);
        return {
          ...h,
          expanded: existing?.expanded || false,
          enabled: String(config[h.enabledKey]) === "true",
          uri: config[h.uriKey] || existing?.uri || ""
        };
      });
    } else if (configQuery.isError || (untrack(() => hooks.length) === 0 && !configQuery.isPending)) {
      hooks = HOOKS_DEF.map(h => ({ ...h, expanded: false, enabled: false, uri: "" }));
    }
  });

  const isLoading = $derived(configQuery.isPending);
  const saveMutation = createMutation(() => ({
    mutationFn: async () => {
      const payload: Record<string, string> = {};
      for (const h of hooks) {
        payload[h.enabledKey] = h.enabled ? "true" : "false";
        if (h.enabled) {
          payload[h.uriKey] = h.uri;
        } else {
          payload[h.uriKey] = "";
        }
      }
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("保存失败");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth_config", projectRef] });
      saveMsg = "✅ Auth Hooks 配置已保存（GoTrue 将重启）";
      setTimeout(() => saveMsg = null, 4000);
    },
    onError: (err: unknown) => {
      saveMsg = `❌ 保存失败: ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => saveMsg = null, 4000);
    }
  }));

  async function saveHooks() {
    saveMsg = null;
    saveMutation.mutate();
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Auth Hooks</h1>
      <p class="text-sm text-muted-foreground mt-1">在认证流程的关键节点插入自定义逻辑</p>
    </div>
    <button onclick={saveHooks} disabled={saveMutation.isPending}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
      {#if saveMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
      保存配置
    </button>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {saveMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">{saveMsg}</div>
  {/if}

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Webhook size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">Auth Hooks 允许你在认证流程中注入自定义代码。支持使用 PostgreSQL 函数 `pg-functions://...` 或 HTTP 端点 `https://...`。保存后你的配置将被注入环境变量，并触发服务热重启。</p>
  </div>

  <div class="flex-1 space-y-3">
    {#if isLoading}
      <div class="rounded-xl border bg-card flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在加载 Auth Hooks...</p>
      </div>
    {:else}
      {#each hooks as hook (hook.id)}
        <div class="rounded-xl border bg-card overflow-hidden">
          <button onclick={() => hook.expanded = !hook.expanded} class="w-full px-5 py-4 flex items-center justify-between hover:bg-muted/10 transition-colors">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg flex items-center justify-center {hook.enabled ? 'bg-brand/10 text-brand' : 'bg-muted/50 text-muted-foreground'}">
                {#if hook.hook_type === "http"}<Webhook size={16} />{:else}<Zap size={16} />{/if}
              </div>
              <div class="text-left">
                <span class="font-semibold text-sm">{hook.name}</span>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase {hook.hook_type === 'http' ? 'text-blue-600 bg-blue-500/10' : 'text-violet-600 bg-violet-500/10'}">{hook.hook_type}</span>
                  <span class="text-[10px] text-muted-foreground">{hook.description}</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-3">
              {#if hook.enabled}
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/10 text-green-600">已启用</span>
              {:else}
                <span class="px-2 py-0.5 rounded-full text-[10px] bg-muted text-muted-foreground">未启用</span>
              {/if}
              {#if hook.expanded}<ChevronUp size={14} class="text-muted-foreground" />{:else}<ChevronDown size={14} class="text-muted-foreground" />{/if}
            </div>
          </button>
          
          {#if hook.expanded}
            <div class="px-5 pb-5 pt-2 border-t border-border/10 space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <h4 class="text-sm font-semibold">启用该 Hook</h4>
                  <p class="text-[10px] text-muted-foreground mt-0.5">打开此开关后，认证系统会路由到下方配置的端点</p>
                </div>
                <button aria-label="Action button" onclick={() => hook.enabled = !hook.enabled}
                  class="relative w-10 h-5 rounded-full transition-colors {hook.enabled ? 'bg-brand' : 'bg-muted'}">
                  <span class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform {hook.enabled ? 'translate-x-5' : ''}"></span>
                </button>
              </div>
              <div class={hook.enabled ? '' : 'opacity-50 pointer-events-none'}>
                <span class="text-[10px] font-semibold text-muted-foreground uppercase">Hook URI</span>
                <input type="text" bind:value={hook.uri} placeholder={hook.hook_type === 'http' ? 'https://...' : 'pg-functions://postgres/public/custom_hook'}
                  class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
                <p class="text-[9px] text-muted-foreground mt-1">例如: pg-functions://postgres/public/your_function_name</p>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>
