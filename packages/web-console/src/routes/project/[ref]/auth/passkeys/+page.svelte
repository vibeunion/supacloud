<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
  import { Fingerprint, Loader2, Save, ShieldCheck } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  const projectRef = $derived(page.params.ref ?? "");
  let loading = $state(true);
  let saving = $state(false);
  let enabled = $state(false);
  let rpId = $state("");
  let rpDisplayName = $state("SupaCloud");
  let rpOriginsText = $state("");
  let errorMessage = $state("");

  function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  async function responseMessage(response: Response, fallback: string): Promise<string> {
    const payload = record(await response.json().catch(() => null));
    return typeof payload.message === "string" && payload.message.trim() ? payload.message : fallback;
  }

  async function loadConfig() {
    loading = true;
    errorMessage = "";
    try {
      const response = await apiClient(`/v1/projects/${projectRef}/config/auth`);
      if (!response.ok) throw new Error(await responseMessage(response, $t("Passkeys.load_failed")));
      const config = record(await response.json());
      enabled = config.passkey_enabled === true;
      rpId = typeof config.webauthn_rp_id === "string" ? config.webauthn_rp_id : "";
      rpDisplayName = typeof config.webauthn_rp_display_name === "string"
        ? config.webauthn_rp_display_name
        : "SupaCloud";
      rpOriginsText = typeof config.webauthn_rp_origins === "string"
        ? config.webauthn_rp_origins.split(",").join("\n")
        : Array.isArray(config.webauthn_rp_origins)
          ? config.webauthn_rp_origins.filter((origin): origin is string => typeof origin === "string").join("\n")
          : "";
    } catch (error: unknown) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function origins(): string[] {
    return [...new Set(rpOriginsText.split(/[\n,]/).map((origin) => origin.trim()).filter(Boolean))];
  }

  async function saveConfig() {
    if (enabled && (!rpId.trim() || !rpDisplayName.trim() || origins().length === 0)) {
      toast.error($t("Passkeys.validation_error"));
      return;
    }
    saving = true;
    try {
      const response = await apiClient(`/v1/projects/${projectRef}/config/auth`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          passkey_enabled: enabled,
          webauthn_rp_id: rpId.trim() || null,
          webauthn_rp_display_name: rpDisplayName.trim() || null,
          webauthn_rp_origins: origins().join(","),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, $t("Passkeys.save_failed")));
      toast.success($t("Passkeys.save_success"));
      await loadConfig();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : $t("Passkeys.save_failed"));
    } finally {
      saving = false;
    }
  }

  onMount(() => { void loadConfig(); });
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">{$t("Passkeys.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Passkeys.subtitle")}</p>
    </div>
    <button onclick={saveConfig} disabled={loading || saving}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
      {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
      {$t("Common.save")}
    </button>
  </div>

  {#if errorMessage}
    <div class="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-700">{errorMessage}</div>
  {/if}

  {#if loading}
    <div class="rounded-xl border bg-card py-24 flex justify-center"><Loader2 class="animate-spin text-brand" /></div>
  {:else}
    <div class="rounded-xl border bg-card p-5 space-y-5">
      <div class="flex items-start justify-between gap-6">
        <div class="flex gap-3">
          <div class="rounded-lg bg-brand/10 p-2 text-brand"><Fingerprint size={20} /></div>
          <div>
            <h2 class="font-semibold">{$t("Passkeys.enable_title")}</h2>
            <p class="text-xs text-muted-foreground mt-1">{$t("Passkeys.enable_description")}</p>
          </div>
        </div>
        <input type="checkbox" bind:checked={enabled} class="h-5 w-5 rounded border" />
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <label class="space-y-1.5 text-xs font-medium">{$t("Passkeys.rp_id")}
          <input bind:value={rpId} placeholder="login.example.com" disabled={!enabled}
            class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono disabled:opacity-50" />
        </label>
        <label class="space-y-1.5 text-xs font-medium">{$t("Passkeys.rp_display_name")}
          <input bind:value={rpDisplayName} placeholder="Example App" disabled={!enabled}
            class="w-full rounded-lg border bg-muted/20 px-3 py-2 disabled:opacity-50" />
        </label>
        <label class="space-y-1.5 text-xs font-medium">{$t("Passkeys.allowed_origins")}
          <textarea bind:value={rpOriginsText} rows="4" placeholder="https://app.example.com" disabled={!enabled}
            class="w-full rounded-lg border bg-muted/20 px-3 py-2 font-mono disabled:opacity-50"></textarea>
        </label>
      </div>

      <div class="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-800">
        <ShieldCheck size={16} class="shrink-0" />
        <div class="space-y-1">
          <p>{$t("Passkeys.security_warning")}</p>
          <p>{$t("Passkeys.sdk_warning_before")} <code>auth.experimental.passkey = true</code>{$t("Passkeys.sdk_warning_after")}</p>
        </div>
      </div>
    </div>
  {/if}
</div>
