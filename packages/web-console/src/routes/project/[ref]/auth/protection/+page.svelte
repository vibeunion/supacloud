<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Shield, Ban, AlertTriangle, Globe, Lock, Loader2 } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  interface ProtectionConfig {
    key: string;
    labelKey: string;
    descriptionKey: string;
    icon: typeof import('lucide-svelte').Shield;
    enabled: boolean;
    detailKey: string;
  }

  const INITIAL_CONFIGS: ProtectionConfig[] = [
    { key: "SECURITY_CAPTCHA_ENABLED", labelKey: "AuthProtection.bot_detection", descriptionKey: "AuthProtection.bot_detection_description", icon: Shield, enabled: false, detailKey: "AuthProtection.bot_detection_detail" },
    { key: "SECURITY_IP_RESTRICTION_ENABLED", labelKey: "AuthProtection.ip_restriction", descriptionKey: "AuthProtection.ip_restriction_description", icon: Ban, enabled: false, detailKey: "AuthProtection.ip_restriction_detail" },
    { key: "PASSWORD_HIBC_ENABLE", labelKey: "AuthProtection.breached_passwords", descriptionKey: "AuthProtection.breached_passwords_description", icon: Lock, enabled: true, detailKey: "AuthProtection.breached_passwords_detail" },
    { key: "PASSWORD_STRENGTH_REQUIRE_COMPLEXITY", labelKey: "AuthProtection.password_strength", descriptionKey: "AuthProtection.password_strength_description", icon: Lock, enabled: true, detailKey: "AuthProtection.password_strength_detail" },
    { key: "SECURITY_LOCKOUT_ENABLED", labelKey: "AuthProtection.lockout", descriptionKey: "AuthProtection.lockout_description", icon: Ban, enabled: false, detailKey: "AuthProtection.lockout_detail" },
    { key: "SECURITY_CORS_RESTRICTION_ENABLED", labelKey: "AuthProtection.cors", descriptionKey: "AuthProtection.cors_description", icon: Globe, enabled: true, detailKey: "AuthProtection.cors_detail" },
  ];

  const configQuery = createQuery(() => ({
    queryKey: ["auth_config", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`);
      if (!res.ok) throw new Error("Failed to load config");
      return await res.json();
    }
  }));

  let configs = $state<ProtectionConfig[]>([]);

  $effect(() => {
    if (configQuery.data) {
      const configData = configQuery.data;
      configs = INITIAL_CONFIGS.map(cfg => ({
        ...cfg,
        enabled: configData[cfg.key] !== undefined ? String(configData[cfg.key]) === "true" : cfg.enabled
      }));
    } else if (configQuery.isError || (configs.length === 0 && !configQuery.isPending)) {
      configs = INITIAL_CONFIGS.map(cfg => ({ ...cfg }));
    }
  });

  const isLoading = $derived(configQuery.isPending);
  let saveMsg = $state<string | null>(null);

  const toggleMutation = createMutation(() => ({
    mutationFn: async ({ index, enabled }: { index: number, enabled: boolean }) => {
      const cfg = configs[index];
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [cfg.key]: String(enabled) })
      });
      if (!res.ok) throw new Error("Failed to save");
      return { index, enabled, cfg };
    },
    onMutate: async ({ index, enabled }) => {
      // Optimistic update
      configs[index].enabled = enabled;
      return { previousConfig: configs[index].enabled };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["auth_config", projectRef] });
      saveMsg = `✅ ${$t(data.cfg.labelKey)} ${$t(data.enabled ? "AuthProtection.enabled" : "AuthProtection.disabled")}`;
      setTimeout(() => saveMsg = null, 3000);
    },
    onError: (err, variables, context) => {
      // Revert optimistic update
      configs[variables.index].enabled = !variables.enabled;
      saveMsg = `❌ ${$t("AuthProtection.save_failed")}`;
      setTimeout(() => saveMsg = null, 3000);
    }
  }));

  function toggleConfig(index: number) {
    if (toggleMutation.isPending) return;
    saveMsg = null;
    toggleMutation.mutate({ index, enabled: !configs[index].enabled });
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
      <h1 class="text-2xl font-bold">{$t("AuthProtection.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("AuthProtection.subtitle")}</p>
  </div>

  <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
    <p class="text-xs text-amber-700">{$t("AuthProtection.warning")}</p>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border {saveMsg.startsWith('❌') ? 'bg-red-500/10 border-red-500/20 text-red-600' : 'bg-green-500/10 border-green-500/20 text-green-600'} px-4 py-2 text-xs font-medium">
      {saveMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-20">
      <Loader2 size={24} class="animate-spin text-muted-foreground opacity-50" />
    </div>
  {:else}
    <div class="space-y-3">
      {#each configs as _, i}
        {@const cfg = configs[i]}
        <div class="rounded-xl border bg-card p-4 flex items-center justify-between hover:bg-muted/5 transition-colors">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg flex items-center justify-center {cfg.enabled ? 'bg-green-500/10 text-green-600' : 'bg-muted/50 text-muted-foreground'}">
              <cfg.icon size={16} />
            </div>
            <div>
              <span class="font-semibold text-sm">{$t(cfg.labelKey)}</span>
              <p class="text-[10px] text-muted-foreground">{$t(cfg.descriptionKey)}</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-[10px] text-muted-foreground hidden md:block">{$t(cfg.detailKey)}</span>
            <button 
              onclick={() => toggleConfig(i)}
              disabled={toggleMutation.isPending}
              class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 {cfg.enabled ? 'bg-brand' : 'bg-muted-foreground/30'} transition-colors disabled:opacity-50"
            >
              <span class="sr-only">{$t("AuthProtection.use_setting")}</span>
              <span aria-hidden="true" class="pointer-events-none absolute left-0 inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform duration-200 ease-in-out {cfg.enabled ? 'translate-x-4' : 'translate-x-0.5'}"></span>
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
