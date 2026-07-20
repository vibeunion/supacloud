<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
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
    if (response.status === 403) return { kind: "forbidden", message: payloadMessage(payload, "你没有查看 MFA 的权限") };
    if (response.status === 404) return { kind: "not_found", message: payloadMessage(payload, "项目或 MFA 资源不存在") };
    if (response.status === 501) return { kind: "unsupported", message: payloadMessage(payload, "当前 GoTrue 运行时不支持此能力") };
    if (response.status === 503) return { kind: "unavailable", message: payloadMessage(payload, "GoTrue MFA 服务暂不可用") };
    return { kind: "error", message: payloadMessage(payload, "无法加载 MFA 因子") };
  }

  function errorTitle(kind: ErrorKind): string {
    if (kind === "forbidden") return "无访问权限";
    if (kind === "not_found") return "资源不存在";
    if (kind === "unsupported") return "运行时不支持";
    if (kind === "unavailable") return "服务暂不可用";
    return "加载失败";
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
      loadError = { kind: "not_found", message: "项目标识不存在" };
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
        loadError = { kind: "error", message: "MFA 因子响应格式无效" };
        return;
      }
      const parsedTotal = Number(factorPayload.total ?? 0);
      if (!Number.isSafeInteger(parsedTotal) || parsedTotal < 0) {
        loadError = { kind: "error", message: "MFA 因子总数响应格式无效" };
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
    if (!window.confirm(`确定要从 GoTrue 中移除 TOTP 因子“${factorLabel}”吗？`)) return;

    deletingFactorId = factor.id;
    try {
      const response = await apiClient(
        `/v1/projects/${encodeURIComponent(projectRef)}/auth/factors/${encodeURIComponent(factor.id)}`,
        { method: "DELETE" },
      );
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(pageError(response, payload).message);

      toast.success("TOTP 因子已从 GoTrue 移除");
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
      <h1 class="text-2xl font-bold">多因素认证</h1>
      <p class="mt-1 text-sm text-muted-foreground">查看 GoTrue 权威 TOTP 因子、用户容量和最近 Session AAL。</p>
    </div>
    <button
      class="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50 disabled:opacity-50"
      onclick={loadMfaPage}
      disabled={loading || deletingFactorId !== null}
    >
      <RefreshCw size={14} class={loading ? "animate-spin" : ""} />
      刷新
    </button>
  </div>

  <div class="grid gap-3 md:grid-cols-3">
    <div class="rounded-xl border bg-card p-4">
      <div class="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck size={14} /> 支持方式</div>
      <div class="mt-2 text-lg font-semibold">GoTrue TOTP</div>
      <p class="mt-1 text-xs text-emerald-600">原生注册、Challenge、验证与移除</p>
    </div>
    <div class="rounded-xl border bg-card p-4">
      <div class="flex items-center gap-2 text-xs text-muted-foreground"><Users size={14} /> 当前页因子</div>
      <div class="mt-2 text-lg font-semibold">{factors.length} / {total}</div>
      <p class="mt-1 text-xs text-muted-foreground">其中 {verifiedTotal} 个已验证</p>
    </div>
    <div class="rounded-xl border bg-card p-4">
      <div class="flex items-center gap-2 text-xs text-muted-foreground"><KeyRound size={14} /> 每用户因子容量</div>
      <div class="mt-2 text-lg font-semibold">{factorCapacity ?? "GoTrue 默认值"}</div>
      {#if capacityError}
        <p class="mt-1 text-xs text-amber-600">容量回读不可用：{capacityError}</p>
      {:else if factorCapacity === null}
        <p class="mt-1 text-xs text-muted-foreground">运行时未显式配置，遵循 GoTrue 默认值</p>
      {:else}
        <p class="mt-1 text-xs text-muted-foreground">来自已应用的 GoTrue 配置</p>
      {/if}
    </div>
  </div>

  <div class="flex items-start gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
    <ShieldCheck size={14} class="mt-0.5 shrink-0 text-blue-600" />
    <p class="text-xs text-blue-700">TOTP 注册属于已登录用户的 GoTrue ceremony；管理控制台只查看权威状态并执行管理员移除。</p>
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
      <button class="mt-4 rounded-md border px-3 py-2 text-xs hover:bg-muted/50" onclick={loadMfaPage}>重试</button>
    </div>
  {:else if factors.length === 0}
    <div class="flex min-h-[260px] flex-col items-center justify-center rounded-xl border bg-card p-6 text-center">
      <ShieldCheck size={28} class="text-muted-foreground" />
      <h2 class="mt-3 text-sm font-semibold">尚无 TOTP 因子</h2>
      <p class="mt-1 text-xs text-muted-foreground">用户完成 GoTrue TOTP 注册并验证后，因子会显示在这里。</p>
    </div>
  {:else}
    <div class="overflow-hidden rounded-xl border bg-card">
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th class="px-4 py-3 font-medium">用户</th>
              <th class="px-4 py-3 font-medium">TOTP 因子</th>
              <th class="px-4 py-3 font-medium">状态</th>
              <th class="px-4 py-3 font-medium">最近 Session AAL</th>
              <th class="px-4 py-3 font-medium">用户容量</th>
              <th class="px-4 py-3 font-medium">更新时间</th>
              <th class="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            {#each factors as factor (factor.id)}
              <tr class="hover:bg-muted/20">
                <td class="px-4 py-3">
                  <div class="font-medium">{factor.user_email || "未设置邮箱"}</div>
                  <div class="mt-0.5 font-mono text-[10px] text-muted-foreground">{factor.user_id}</div>
                </td>
                <td class="px-4 py-3">
                  <div class="font-medium">{factor.friendly_name || "Authenticator"}</div>
                  <div class="mt-0.5 font-mono text-[10px] text-muted-foreground">{factor.id}</div>
                </td>
                <td class="px-4 py-3">
                  <span class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium {factor.status === 'verified' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700'}">
                    {#if factor.status === "verified"}<CheckCircle2 size={11} />{/if}
                    {factor.status === "verified" ? "已验证" : "待验证"}
                  </span>
                </td>
                <td class="px-4 py-3">
                  <span class="inline-flex rounded-full px-2 py-1 text-[10px] font-medium {factor.latest_session_aal === 'aal2' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-muted text-muted-foreground'}">
                    {factor.latest_session_aal?.toUpperCase() || "无 Session"}
                  </span>
                  <div class="mt-1 text-[10px] text-muted-foreground">{formatDate(factor.latest_session_updated_at)}</div>
                </td>
                <td class="px-4 py-3">
                  <div class="font-medium">{factor.enrolled_factor_count} / {factorCapacity ?? "默认上限"}</div>
                  <div class="mt-0.5 text-[10px] text-muted-foreground">已验证 {factor.verified_factor_count}</div>
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
                    移除
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
        <span>第 {currentPage} / {totalPages} 页，共 {total} 个 TOTP 因子</span>
        <div class="flex gap-2">
          <button
            class="rounded-md border px-3 py-1.5 hover:bg-muted/50 disabled:opacity-40"
            onclick={() => changePage(currentPage - 1)}
            disabled={currentPage <= 1 || loading}
          >上一页</button>
          <button
            class="rounded-md border px-3 py-1.5 hover:bg-muted/50 disabled:opacity-40"
            onclick={() => changePage(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
          >下一页</button>
        </div>
      </div>
    </div>
  {/if}
</div>
