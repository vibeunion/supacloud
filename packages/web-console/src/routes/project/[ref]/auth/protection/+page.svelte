<script lang="ts">
  import { apiClient } from "$lib/api";
  import { page } from "$app/state";
  import { AlertTriangle, Loader2 } from "lucide-svelte";
  import { t } from "svelte-i18n";
  import { createQuery } from "@tanstack/svelte-query";
  import {
    parseProtectionSettings,
    protectionKeys,
    type ProtectionKey,
  } from "$lib/auth-settings";

  const labels: Record<ProtectionKey, string> = {
    SECURITY_CAPTCHA_ENABLED: "AuthProtection.bot_detection",
    SECURITY_IP_RESTRICTION_ENABLED: "AuthProtection.ip_restriction",
    PASSWORD_HIBC_ENABLE: "AuthProtection.breached_passwords",
    PASSWORD_STRENGTH_REQUIRE_COMPLEXITY: "AuthProtection.password_strength",
    SECURITY_LOCKOUT_ENABLED: "AuthProtection.lockout",
    SECURITY_CORS_RESTRICTION_ENABLED: "AuthProtection.cors",
  };

  const projectRef = $derived(page.params.ref);

  const configQuery = createQuery(() => ({
    queryKey: ["auth_config", projectRef],
    queryFn: async () => {
      if (!projectRef) throw new Error("Failed to load auth configuration");
      const response = await apiClient(`/v1/projects/${encodeURIComponent(projectRef)}/auth/config`);
      if (!response.ok) throw new Error("Failed to load auth configuration");
      return parseProtectionSettings(await response.json());
    },
  }));

  let overrides = $state<Partial<Record<ProtectionKey, boolean>>>({});
  let savingKey = $state<ProtectionKey | null>(null);

  $effect(() => {
    void projectRef;
    overrides = {};
    savingKey = null;
  });

  function value(key: ProtectionKey): boolean {
    if (Object.hasOwn(overrides, key)) return overrides[key] ?? false;
    return configQuery.data?.[key] ?? false;
  }

  async function toggle(key: ProtectionKey) {
    const ref = projectRef;
    if (!ref || savingKey) return;
    const next = !value(key);
    overrides = { ...overrides, [key]: next };
    savingKey = key;
    try {
      const response = await apiClient(`/v1/projects/${encodeURIComponent(ref)}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: String(next) }),
      });
      if (!response.ok) throw new Error("Failed to save auth configuration");
    } catch {
      if (projectRef === ref) overrides = { ...overrides, [key]: !next };
    } finally {
      if (projectRef === ref) savingKey = null;
    }
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

  {#if configQuery.isPending}
    <div class="flex items-center justify-center py-20">
      <Loader2 size={24} class="animate-spin text-muted-foreground opacity-50" />
    </div>
  {:else if configQuery.isError}
    <div role="alert" class="flex items-center justify-center py-20 text-sm text-destructive">
      {$t("AuthProtection.save_failed")}
    </div>
  {:else}
    <div class="space-y-3">
      {#each protectionKeys as key (key)}
        {@const enabled = value(key)}
        <div class="rounded-xl border bg-card p-4 flex items-center justify-between hover:bg-muted/5 transition-colors">
          <span class="font-semibold text-sm">{$t(labels[key])}</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={$t(labels[key])}
            onclick={() => toggle(key)}
            disabled={savingKey !== null}
            class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 {enabled ? 'bg-brand' : 'bg-muted-foreground/30'} transition-colors disabled:opacity-50"
          >
            <span aria-hidden="true" class="pointer-events-none absolute left-0 inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform duration-200 ease-in-out {enabled ? 'translate-x-4' : 'translate-x-0.5'}"></span>
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>