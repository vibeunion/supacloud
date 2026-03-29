<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Timer, ShieldAlert, Mail, KeyRound, Smartphone, AlertTriangle, Loader2, Save, RefreshCw } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface RateLimit {
    name: string;
    description: string;
    value: string;
    unit: string;
    icon: typeof Timer;
    category: "auth" | "email" | "sms" | "otp";
    envKey: string;
  }

  const RATE_LIMITS_DEF: Omit<RateLimit, 'value'>[] = [
    { name: "Rate limit for signup", description: "每个 IP 在一段时间内的最大注册请求数", unit: "请求/小时", icon: KeyRound, category: "auth", envKey: "RATE_LIMIT_SIGNUP" },
    { name: "Rate limit for sign-in", description: "每个 IP 在一段时间内的最大登录请求数", unit: "请求/小时", icon: KeyRound, category: "auth", envKey: "RATE_LIMIT_SIGNIN" },
    { name: "Rate limit for token refresh", description: "每个 IP 的 Token 刷新速率限制", unit: "请求/小时", icon: Timer, category: "auth", envKey: "RATE_LIMIT_TOKEN_REFRESH" },
    { name: "Rate limit for sending emails", description: "每个用户的邮件发送速率限制", unit: "封/小时", icon: Mail, category: "email", envKey: "RATE_LIMIT_EMAIL_SENT" },
    { name: "Rate limit for email OTP", description: "邮件 OTP 验证码的速率限制", unit: "封/小时", icon: Mail, category: "otp", envKey: "RATE_LIMIT_EMAIL_OTP" },
    { name: "Rate limit for sending SMS", description: "每个用户的短信发送速率限制", unit: "条/小时", icon: Smartphone, category: "sms", envKey: "RATE_LIMIT_SMS_SENT" },
    { name: "Rate limit for SMS OTP", description: "短信 OTP 验证码的速率限制", unit: "条/小时", icon: Smartphone, category: "otp", envKey: "RATE_LIMIT_SMS_OTP" },
    { name: "Rate limit for verify", description: "验证端点的速率限制", unit: "请求/小时", icon: ShieldAlert, category: "auth", envKey: "RATE_LIMIT_VERIFY" },
    { name: "Rate limit for anonymous sign-in", description: "匿名登录的速率限制", unit: "请求/小时", icon: KeyRound, category: "auth", envKey: "RATE_LIMIT_ANONYMOUS_SIGN_IN" },
  ];

  const DEFAULT_VALUES: Record<string, string> = {
    RATE_LIMIT_SIGNUP: "30", RATE_LIMIT_SIGNIN: "30", RATE_LIMIT_TOKEN_REFRESH: "150",
    RATE_LIMIT_EMAIL_SENT: "5", RATE_LIMIT_EMAIL_OTP: "5",
    RATE_LIMIT_SMS_SENT: "5", RATE_LIMIT_SMS_OTP: "5",
    RATE_LIMIT_VERIFY: "30", RATE_LIMIT_ANONYMOUS_SIGN_IN: "30",
  };

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

  let limits = $state<RateLimit[]>([]);

  $effect(() => {
    if (configQuery.data) {
      const config = configQuery.data;
      limits = RATE_LIMITS_DEF.map(def => ({
        ...def,
        value: String(config[def.envKey] ?? DEFAULT_VALUES[def.envKey] ?? "30"),
      }));
    } else if (configQuery.isError || (limits.length === 0 && !configQuery.isPending)) {
      limits = RATE_LIMITS_DEF.map(def => ({
        ...def,
        value: DEFAULT_VALUES[def.envKey] || "30",
      }));
    }
  });

  const isLoading = $derived(configQuery.isPending);

  const saveMutation = createMutation(() => ({
    mutationFn: async () => {
      const payload: Record<string, string> = {};
      for (const l of limits) { payload[l.envKey] = l.value; }
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || res.statusText);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth_config", projectRef] });
      saveMsg = "✅ 速率限制已保存（GoTrue 服务已重启）";
      setTimeout(() => saveMsg = null, 4000);
    },
    onError: (err: unknown) => {
      saveMsg = `❌ 保存失败: ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => saveMsg = null, 4000);
    }
  }));

  async function saveConfig() {
    saveMsg = null;
    saveMutation.mutate();
  }

  function getCategoryColor(cat: string): string {
    if (cat === "auth") return "text-blue-600 bg-blue-500/10";
    if (cat === "email") return "text-violet-600 bg-violet-500/10";
    if (cat === "sms") return "text-green-600 bg-green-500/10";
    return "text-amber-600 bg-amber-500/10";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">速率限制</h1>
      <p class="text-sm text-muted-foreground mt-1">认证端点的速率限制配置，保护应用免受滥用</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={() => queryClient.invalidateQueries({ queryKey: ["auth_config", projectRef] })} class="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <RefreshCw size={12} /> 刷新
      </button>
      <button onclick={saveConfig} disabled={saveMutation.isPending || isLoading}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
        {#if saveMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
        保存配置
      </button>
    </div>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {saveMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">{saveMsg}</div>
  {/if}

  <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
    <p class="text-xs text-amber-700">修改速率限制后将自动更新 GoTrue 环境变量并重启服务。请谨慎设置，过低的限制可能影响正常用户体验。</p>
  </div>

  {#if isLoading}
    <div class="flex items-center justify-center py-24"><Loader2 size={32} class="animate-spin text-brand opacity-50" /></div>
  {:else}
    <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
      <div class="overflow-auto">
        <div class="divide-y divide-border/20">
          {#each limits as limit, i}
            <div class="flex items-center justify-between px-5 py-4 hover:bg-muted/10 transition-colors">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-lg {getCategoryColor(limit.category)} flex items-center justify-center">
                  <limit.icon size={14} />
                </div>
                <div>
                  <span class="font-medium text-sm">{limit.name}</span>
                  <p class="text-[10px] text-muted-foreground mt-0.5">{limit.description}</p>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase {getCategoryColor(limit.category)}">{limit.category}</span>
                <div class="flex items-center gap-1.5">
                  <input type="number" bind:value={limits[i].value} min="1" max="10000"
                    class="w-20 px-2 py-1.5 text-sm font-mono font-bold text-center rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
                  <span class="text-[10px] text-muted-foreground whitespace-nowrap">{limit.unit}</span>
                </div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
