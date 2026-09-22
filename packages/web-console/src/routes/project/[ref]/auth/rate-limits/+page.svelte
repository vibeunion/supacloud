<script lang="ts">
  import { apiClient } from "$lib/api";
  import { page } from "$app/state";
  import { Loader2, RefreshCw, Save } from "lucide-svelte";
  import { t } from "svelte-i18n";
  import {
    isRateLimitValue,
    parseRateLimitReceipt,
    parseRateLimitSettings,
    rateLimitKeys,
    type RateLimitKey,
    type RateLimitSettings,
  } from "$lib/auth-settings";

  const projectRef = $derived(page.params.ref);

  let settings = $state<RateLimitSettings>({});
  let drafts = $state<Partial<Record<RateLimitKey, string>>>({});
  let loading = $state(false);
  let loadError = $state(false);
  let busy = $state(false);
  let refreshKey = $state(0);
  let message = $state<{ kind: "status" | "error"; text: string } | null>(null);

  $effect(() => {
    const ref = projectRef;
    void refreshKey;
    const controller = new AbortController();
    settings = {};
    drafts = {};
    message = null;
    loadError = false;
    loading = Boolean(ref);
    if (!ref) return () => controller.abort();
    void (async () => {
      try {
        const response = await apiClient(
          `/v1/projects/${encodeURIComponent(ref)}/auth/config`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Failed to load rate limits");
        const parsed = parseRateLimitSettings(await response.json());
        if (!controller.signal.aborted) settings = parsed;
      } catch {
        if (!controller.signal.aborted) loadError = true;
      } finally {
        if (!controller.signal.aborted) loading = false;
      }
    })();
    return () => controller.abort();
  });

  function label(key: RateLimitKey): string {
    return `AuthRateLimits.${key.replace("RATE_LIMIT_", "").toLowerCase()}`;
  }
  function draft(key: RateLimitKey): string {
    if (Object.hasOwn(drafts, key)) return drafts[key] ?? "";
    return settings[key] !== undefined ? String(settings[key]) : "";
  }
  function parsedDraft(key: RateLimitKey): number | undefined {
    const raw = draft(key);
    return /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : undefined;
  }
  function invalid(key: RateLimitKey): boolean {
    const raw = draft(key);
    if (raw === "") return settings[key] !== undefined;
    return !isRateLimitValue(parsedDraft(key));
  }
  function changed(key: RateLimitKey): boolean {
    const raw = draft(key);
    return raw !== "" && parsedDraft(key) !== settings[key];
  }

  const canSave = $derived(
    !loading && !loadError && !busy
      && rateLimitKeys.some((key) => changed(key) && !invalid(key))
      && !rateLimitKeys.some((key) => invalid(key)),
  );

  function edit(key: RateLimitKey, value: string) {
    drafts = { ...drafts, [key]: value };
  }

  async function save() {
    const ref = projectRef;
    if (!ref || !canSave) return;
    const expected: Partial<Record<RateLimitKey, string>> = {};
    for (const key of rateLimitKeys) {
      if (changed(key) && !invalid(key)) expected[key] = String(parsedDraft(key));
    }
    busy = true;
    try {
      const response = await apiClient(
        `/v1/projects/${encodeURIComponent(ref)}/auth/config`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(expected) },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("Failed to save rate limits");
      parseRateLimitReceipt(payload, expected);
      if (projectRef === ref) {
        const unchanged = Object.entries(expected).every(([key, value]) => draft(key as RateLimitKey) === value);
        if (unchanged) {
          const next: RateLimitSettings = { ...settings };
          for (const [key, value] of Object.entries(expected)) next[key as RateLimitKey] = Number(value);
          settings = next;
          drafts = {};
          message = { kind: "status", text: "AuthRateLimits.save_success" };
        }
      }
    } catch {
      if (projectRef === ref) message = { kind: "error", text: "AuthRateLimits.save_failed" };
    } finally {
      busy = false;
    }
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("AuthRateLimits.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("AuthRateLimits.subtitle")}</p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={() => { refreshKey += 1; }}
        disabled={loading}
        class="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50"
      >
        {#if loading}<Loader2 size={14} class="animate-spin" />{:else}<RefreshCw size={14} />{/if}
        {$t("Common.refresh")}
      </button>
      <button
        type="button"
        onclick={save}
        disabled={!canSave}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
      >
        {#if busy}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
        {$t("AuthRateLimits.save")}
      </button>
    </div>
  </div>

  {#if message?.kind === "error" || loadError}
    <div role="alert" class="rounded-lg border bg-red-500/5 border-red-500/20 px-4 py-2 text-xs font-medium text-red-700">
      {message?.text ?? $t("AuthRateLimits.save_failed")}
    </div>
  {:else if message?.kind === "status"}
    <div role="status" class="rounded-lg border bg-green-500/5 border-green-500/20 px-4 py-2 text-xs font-medium text-green-700">
      {message.text}
    </div>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <Loader2 size={24} class="animate-spin text-muted-foreground opacity-50" />
    </div>
  {:else if !loadError}
    <div class="rounded-xl border bg-card divide-y divide-border/20">
      {#each rateLimitKeys as key (key)}
        <div class="flex items-center justify-between px-5 py-3.5">
          <span class="font-mono text-xs text-foreground">{key}</span>
          <input
            type="number"
            aria-label={label(key)}
            aria-invalid={invalid(key) ? "true" : undefined}
            disabled={busy}
            value={draft(key)}
            oninput={(event) => edit(key, (event.currentTarget as HTMLInputElement).value)}
            class="w-40 px-3 py-1.5 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
      {/each}
    </div>
  {/if}
</div>