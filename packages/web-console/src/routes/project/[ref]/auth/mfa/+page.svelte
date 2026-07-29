<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
  import {
    AlertTriangle,
    CheckCircle2,
    KeyRound,
    Loader2,
    RefreshCw,
    ShieldCheck,
    Trash2,
    Users,
  } from "lucide-svelte";
  import { toast } from "svelte-sonner";

  type TotpFactor = {
    id: string;
    user_id: string;
    user_email: string | null;
    friendly_name: string | null;
    factor_type: "totp";
    status: "unverified" | "verified";
    created_at: string;
    updated_at: string;
    enrolled_factor_count: number;
    verified_factor_count: number;
    latest_session_aal: string | null;
    latest_session_updated_at: string | null;
  };

  type ErrorKind = "forbidden" | "not_found" | "unsupported" | "unavailable" | "error";
  type PageError = { kind: ErrorKind; message: string };

  const projectRef = $derived(page.params.ref ?? "");
  const limit = 20;

  let factors = $state<TotpFactor[]>([]);
  let total = $state(0);
  let currentPage = $state(1);
  let loading = $state(true);
  let deletingFactorId = $state<string | null>(null);
  let loadError = $state<PageError | null>(null);
  let factorCapacity = $state<number | null>(null);
  let capacityError = $state<string | null>(null);

  const totalPages = $derived(Math.max(1, Math.ceil(total / limit)));
  const verifiedTotal = $derived(factors.filter((factor) => factor.status === "verified").length);

  function recordPayload(payload: unknown): Record<string, unknown> {
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  }

  async function readPayload(response: Response): Promise<Record<string, unknown>> {
    const responseText = await response.text();
    if (!responseText.trim()) return {};
    try {
      return recordPayload(JSON.parse(responseText) as unknown);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return {};
    }
  }

  function payloadMessage(payload: Record<string, unknown>, fallback: string): string {
    return typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : fallback;
  }

  function pageError(response: Response, payload: Record<string, unknown>): PageError {
    if (response.status === 403) return { kind: "forbidden", message: payloadMessage(payload, $t("AuthMfa.error_forbidden")) };
    if (response.status === 404) return { kind: "not_found", message: payloadMessage(payload, $t("AuthMfa.error_not_found")) };
    if (response.status === 501) return { kind: "unsupported", message: payloadMessage(payload, $t("AuthMfa.error_unsupported")) };
    if (response.status === 503) return { kind: "unavailable", message: payloadMessage(payload, $t("AuthMfa.error_unavailable")) };
    return { kind: "error", message: payloadMessage(payload, $t("AuthMfa.error_load")) };
  }

  function errorTitle(kind: ErrorKind): string {
    if (kind === "forbidden") return $t("AuthMfa.title_forbidden");
    if (kind === "not_found") return $t("AuthMfa.title_not_found");
    if (kind === "unsupported") return $t("AuthMfa.title_unsupported");
    if (kind === "unavailable") return $t("AuthMfa.title_unavailable");
    return $t("AuthMfa.title_load_failed");
  }

  function configuredCapacity(payload: Record<string, unknown>): number | null {
    const parsed = Number(payload.mfa_max_enrolled_factors);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  async function loadMfaPage(): Promise<void> {
    loading = true;
    loadError = null;
    capacityError = null;
    if (!projectRef) {
      loadError = { kind: "not_found", message: $t("AuthMfa.project_missing") };
      loading = false;
      return;
    }
    try {
      const encodedRef = encodeURIComponent(projectRef);
      const [factorResponse, configResponse] = await Promise.all([
        apiClient(`/v1/projects/${encodedRef}/auth/factors?page=${currentPage}&limit=${limit}`),
        apiClient(`/v1/projects/${encodedRef}/config/auth`),
      ]);
      const [factorPayload, configPayload] = await Promise.all([
        readPayload(factorResponse),
        readPayload(configResponse),
      ]);

      if (!factorResponse.ok) {
        loadError = pageError(factorResponse, factorPayload);
        return;
      }
      if (!Array.isArray(factorPayload.items)) {
        loadError = { kind: "error", message: $t("AuthMfa.invalid_response") };
        return;
      }
      const parsedTotal = Number(factorPayload.total ?? 0);
      if (!Number.isSafeInteger(parsedTotal) || parsedTotal < 0) {
        loadError = { kind: "error", message: $t("AuthMfa.invalid_total") };
        return;
      }

      factors = factorPayload.items as TotpFactor[];
      total = parsedTotal;
      if (configResponse.ok) {
        factorCapacity = configuredCapacity(configPayload);
      } else {
        factorCapacity = null;
        capacityError = pageError(configResponse, configPayload).message;
      }
    } catch (error) {
      loadError = {
        kind: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      loading = false;
    }
  }

  async function deleteFactor(factor: TotpFactor): Promise<void> {
    const factorLabel = factor.friendly_name || factor.user_email || factor.id;
    if (!window.confirm($t("AuthMfa.delete_confirmation", { values: { factor: factorLabel } }))) return;

    deletingFactorId = factor.id;
    try {
      const response = await apiClient(
        `/v1/projects/${encodeURIComponent(projectRef)}/auth/factors/${encodeURIComponent(factor.id)}`,
        { method: "DELETE" },
      );
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(pageError(response, payload).message);

      toast.success($t("AuthMfa.deleted"));
      if (factors.length === 1 && currentPage > 1) currentPage -= 1;
      await loadMfaPage();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      deletingFactorId = null;
    }
  }

  async function changePage(nextPage: number): Promise<void> {
    if (nextPage < 1 || nextPage > totalPages || nextPage === currentPage) return;
    currentPage = nextPage;
    await loadMfaPage();
  }

  function formatDate(value: string | null): string {
    if (!value) return "—";
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  onMount(() => void loadMfaPage());
</script>

<div class="flex h-full flex-col gap-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-bold">{$t("AuthMfa.title")}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{$t("AuthMfa.subtitle")}</p>
    </div>
    <button
      class="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50 disabled:opacity-50"
      onclick={loadMfaPage}
      disabled={loading || deletingFactorId !== null}
    >
      <RefreshCw size={14} class={loading ? "animate-spin" : ""} />
      {$t("Common.refresh")}
    </button>
  </div>

  <div class="grid gap-3 md:grid-cols-3">
    <div class="rounded-xl border bg-card p-4">
      <div class="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck size={14} /> {$t("AuthMfa.supported_method")}</div>
      <div class="mt-2 text-lg font-semibold">GoTrue TOTP</div>
      <p class="mt-1 text-xs text-emerald-600">{$t("AuthMfa.supported_method_description")}</p>
    </div>
    <div class="rounded-xl border bg-card p-4">
      <div class="flex items-center gap-2 text-xs text-muted-foreground"><Users size={14} /> {$t("AuthMfa.current_page_factors")}</div>
      <div class="mt-2 text-lg font-semibold">{factors.length} / {total}</div>
      <p class="mt-1 text-xs text-muted-foreground">{$t("AuthMfa.verified_count", { values: { count: verifiedTotal } })}</p>
    </div>
    <div class="rounded-xl border bg-card p-4">
      <div class="flex items-center gap-2 text-xs text-muted-foreground"><KeyRound size={14} /> {$t("AuthMfa.factor_capacity")}</div>
      <div class="mt-2 text-lg font-semibold">{factorCapacity ?? $t("AuthMfa.gotrue_default")}</div>
      {#if capacityError}
        <p class="mt-1 text-xs text-amber-600">{$t("AuthMfa.capacity_readback_unavailable", { values: { error: capacityError } })}</p>
      {:else if factorCapacity === null}
        <p class="mt-1 text-xs text-muted-foreground">{$t("AuthMfa.capacity_uses_default")}</p>
      {:else}
        <p class="mt-1 text-xs text-muted-foreground">{$t("AuthMfa.capacity_applied_config")}</p>
      {/if}
    </div>
  </div>

  <div class="flex items-start gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
    <ShieldCheck size={14} class="mt-0.5 shrink-0 text-blue-600" />
    <p class="text-xs text-blue-700">{$t("AuthMfa.ceremony_note")}</p>
  </div>

  {#if loading}
    <div class="flex min-h-[320px] items-center justify-center rounded-xl border bg-card">
      <Loader2 size={24} class="animate-spin text-muted-foreground" />
    </div>
  {:else if loadError}
    <div class="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
      <AlertTriangle size={26} class="text-destructive" />
      <h2 class="mt-3 text-sm font-semibold">{errorTitle(loadError.kind)}</h2>
      <p class="mt-1 max-w-xl text-xs text-muted-foreground">{loadError.message}</p>
      <button class="mt-4 rounded-md border px-3 py-2 text-xs hover:bg-muted/50" onclick={loadMfaPage}>{$t("Common.retry")}</button>
    </div>
  {:else if factors.length === 0}
    <div class="flex min-h-[260px] flex-col items-center justify-center rounded-xl border bg-card p-6 text-center">
      <ShieldCheck size={28} class="text-muted-foreground" />
      <h2 class="mt-3 text-sm font-semibold">{$t("AuthMfa.empty")}</h2>
      <p class="mt-1 text-xs text-muted-foreground">{$t("AuthMfa.empty_description")}</p>
    </div>
  {:else}
    <div class="overflow-hidden rounded-xl border bg-card">
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th class="px-4 py-3 font-medium">{$t("AuthMfa.user")}</th>
              <th class="px-4 py-3 font-medium">{$t("AuthMfa.totp_factor")}</th>
              <th class="px-4 py-3 font-medium">{$t("AuthMfa.status")}</th>
              <th class="px-4 py-3 font-medium">{$t("AuthMfa.latest_session_aal")}</th>
              <th class="px-4 py-3 font-medium">{$t("AuthMfa.user_capacity")}</th>
              <th class="px-4 py-3 font-medium">{$t("AuthMfa.updated_at")}</th>
              <th class="px-4 py-3 text-right font-medium">{$t("AuthMfa.actions")}</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            {#each factors as factor (factor.id)}
              <tr class="hover:bg-muted/20">
                <td class="px-4 py-3">
                  <div class="font-medium">{factor.user_email || $t("AuthMfa.email_not_set")}</div>
                  <div class="mt-0.5 font-mono text-[10px] text-muted-foreground">{factor.user_id}</div>
                </td>
                <td class="px-4 py-3">
                  <div class="font-medium">{factor.friendly_name || "Authenticator"}</div>
                  <div class="mt-0.5 font-mono text-[10px] text-muted-foreground">{factor.id}</div>
                </td>
                <td class="px-4 py-3">
                  <span class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium {factor.status === 'verified' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700'}">
                    {#if factor.status === "verified"}<CheckCircle2 size={11} />{/if}
                    {factor.status === "verified" ? $t("AuthMfa.verified") : $t("AuthMfa.pending_verification")}
                  </span>
                </td>
                <td class="px-4 py-3">
                  <span class="inline-flex rounded-full px-2 py-1 text-[10px] font-medium {factor.latest_session_aal === 'aal2' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-muted text-muted-foreground'}">
                    {factor.latest_session_aal?.toUpperCase() || $t("AuthMfa.no_session")}
                  </span>
                  <div class="mt-1 text-[10px] text-muted-foreground">{formatDate(factor.latest_session_updated_at)}</div>
                </td>
                <td class="px-4 py-3">
                  <div class="font-medium">{factor.enrolled_factor_count} / {factorCapacity ?? $t("AuthMfa.default_limit")}</div>
                  <div class="mt-0.5 text-[10px] text-muted-foreground">{$t("AuthMfa.verified_count", { values: { count: factor.verified_factor_count } })}</div>
                </td>
                <td class="px-4 py-3 text-xs text-muted-foreground">{formatDate(factor.updated_at)}</td>
                <td class="px-4 py-3 text-right">
                  <button
                    class="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    onclick={() => deleteFactor(factor)}
                    disabled={deletingFactorId !== null}
                  >
                    {#if deletingFactorId === factor.id}
                      <Loader2 size={12} class="animate-spin" />
                    {:else}
                      <Trash2 size={12} />
                    {/if}
                    {$t("AuthMfa.remove")}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
        <span>{$t("AuthMfa.pagination", { values: { currentPage, totalPages, total } })}</span>
        <div class="flex gap-2">
          <button
            class="rounded-md border px-3 py-1.5 hover:bg-muted/50 disabled:opacity-40"
            onclick={() => changePage(currentPage - 1)}
            disabled={currentPage <= 1 || loading}
          >{$t("Common.previous")}</button>
          <button
            class="rounded-md border px-3 py-1.5 hover:bg-muted/50 disabled:opacity-40"
            onclick={() => changePage(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
          >{$t("Common.next")}</button>
        </div>
      </div>
    </div>
  {/if}
</div>
