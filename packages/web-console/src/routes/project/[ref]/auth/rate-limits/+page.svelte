<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Timer, ShieldAlert, Mail, KeyRound, Smartphone, AlertTriangle, Loader2, Save, RefreshCw } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface RateLimit {
    labelKey: string;
    descriptionKey: string;
    value: string;
    unitKey: string;
    icon: typeof Timer;
    category: "auth" | "email" | "sms" | "otp";
    categoryKey: string;
    envKey: string;
  }

  const RATE_LIMITS_DEF: Omit<RateLimit, 'value'>[] = [
    { labelKey: "AuthRateLimits.signup", descriptionKey: "AuthRateLimits.signup_description", unitKey: "AuthRateLimits.requests_per_hour", icon: KeyRound, category: "auth", categoryKey: "AuthRateLimits.category_auth", envKey: "RATE_LIMIT_SIGNUP" },
    { labelKey: "AuthRateLimits.signin", descriptionKey: "AuthRateLimits.signin_description", unitKey: "AuthRateLimits.requests_per_hour", icon: KeyRound, category: "auth", categoryKey: "AuthRateLimits.category_auth", envKey: "RATE_LIMIT_SIGNIN" },
    { labelKey: "AuthRateLimits.token_refresh", descriptionKey: "AuthRateLimits.token_refresh_description", unitKey: "AuthRateLimits.requests_per_hour", icon: Timer, category: "auth", categoryKey: "AuthRateLimits.category_auth", envKey: "RATE_LIMIT_TOKEN_REFRESH" },
    { labelKey: "AuthRateLimits.email_send", descriptionKey: "AuthRateLimits.email_send_description", unitKey: "AuthRateLimits.messages_per_hour", icon: Mail, category: "email", categoryKey: "AuthRateLimits.category_email", envKey: "RATE_LIMIT_EMAIL_SENT" },
    { labelKey: "AuthRateLimits.email_otp", descriptionKey: "AuthRateLimits.email_otp_description", unitKey: "AuthRateLimits.messages_per_hour", icon: Mail, category: "otp", categoryKey: "AuthRateLimits.category_otp", envKey: "RATE_LIMIT_EMAIL_OTP" },
    { labelKey: "AuthRateLimits.sms_send", descriptionKey: "AuthRateLimits.sms_send_description", unitKey: "AuthRateLimits.messages_per_hour", icon: Smartphone, category: "sms", categoryKey: "AuthRateLimits.category_sms", envKey: "RATE_LIMIT_SMS_SENT" },
    { labelKey: "AuthRateLimits.sms_otp", descriptionKey: "AuthRateLimits.sms_otp_description", unitKey: "AuthRateLimits.messages_per_hour", icon: Smartphone, category: "otp", categoryKey: "AuthRateLimits.category_otp", envKey: "RATE_LIMIT_SMS_OTP" },
    { labelKey: "AuthRateLimits.verify", descriptionKey: "AuthRateLimits.verify_description", unitKey: "AuthRateLimits.requests_per_hour", icon: ShieldAlert, category: "auth", categoryKey: "AuthRateLimits.category_auth", envKey: "RATE_LIMIT_VERIFY" },
    { labelKey: "AuthRateLimits.anonymous_signin", descriptionKey: "AuthRateLimits.anonymous_signin_description", unitKey: "AuthRateLimits.requests_per_hour", icon: KeyRound, category: "auth", categoryKey: "AuthRateLimits.category_auth", envKey: "RATE_LIMIT_ANONYMOUS_SIGN_IN" },
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
      saveMsg = `✅ ${$t("AuthRateLimits.save_success")}`;
      setTimeout(() => saveMsg = null, 4000);
    },
    onError: (err: unknown) => {
      saveMsg = `❌ ${$t("AuthRateLimits.save_failed")}: ${err instanceof Error ? err.message : String(err)}`;
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
      <h1 class="text-2xl font-bold">{$t("AuthRateLimits.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("AuthRateLimits.subtitle")}</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={() => queryClient.invalidateQueries({ queryKey: ["auth_config", projectRef] })} class="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors">
        <RefreshCw size={12} /> {$t("Common.refresh")}
      </button>
      <button onclick={saveConfig} disabled={saveMutation.isPending || isLoading}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
        {#if saveMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
        {$t("AuthRateLimits.save")}
      </button>
    </div>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {saveMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">{saveMsg}</div>
  {/if}

  <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
    <p class="text-xs text-amber-700">{$t("AuthRateLimits.warning")}</p>
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
                  <span class="font-medium text-sm">{$t(limit.labelKey)}</span>
                  <p class="text-[10px] text-muted-foreground mt-0.5">{$t(limit.descriptionKey)}</p>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <span title={limit.category} class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase {getCategoryColor(limit.category)}">{$t(limit.categoryKey)}</span>
                <div class="flex items-center gap-1.5">
                  <input type="number" bind:value={limits[i].value} min="1" max="10000"
                    class="w-20 px-2 py-1.5 text-sm font-mono font-bold text-center rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
                  <span class="text-[10px] text-muted-foreground whitespace-nowrap">{$t(limit.unitKey)}</span>
                </div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
