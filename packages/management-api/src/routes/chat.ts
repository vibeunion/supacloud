import { Elysia, t } from "elysia";
import { logger } from "../utils/logger";
import { handleEmbeddingRequest } from "../services/ai-embeddings";
import { getPlatformSetting } from "../services/platform-settings.service";
import { requireAdminAuth } from "../middleware/auth";
import {
  calculateAiCostMicrounits,
  extractAiTokenUsage,
  hashAiProvider,
  listAiUsage,
  parseAiPricing,
  recordAiUsage,
} from "../services/ai-usage-ledger.service";

/**
 * Chat Proxy Routes
 *
 * Proxies OpenAI-compatible /v1/chat/completions requests to the upstream
 * AI provider configured dynamically in platform_settings.
 *
 * Required platform_settings keys:
 *   - ai_api_base   (e.g. "https://api.openai.com/v1")
 *   - ai_api_key    (e.g. "sk-...")
 *   - ai_model      (e.g. "gpt-4o-mini", used as fallback if client omits model)
 */
export const chatRoutes = new Elysia({ name: "chat-proxy" })

  // ─── POST /v1/chat/completions ─────────────────────────────────
  .post("/v1/chat/completions", {
    body: t.Object({
      model: t.Optional(t.String()),
      stream: t.Optional(t.Boolean())
    }, { additionalProperties: true }),
    detail: { tags: ["tasks"], summary: "Proxy chat completion request" },
  }, async ({ body, set }) => {
    // 1. Read dynamic config from DB
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const [aiApiBase, aiApiKey, aiModel, inputRateSetting, outputRateSetting] = await Promise.all([
      getPlatformSetting("ai_api_base"),
      getPlatformSetting("ai_api_key"),
      getPlatformSetting("ai_model"),
      getPlatformSetting("ai_input_cost_per_1m_microunits"),
      getPlatformSetting("ai_output_cost_per_1m_microunits"),
    ]);

    if (!aiApiBase || !aiApiKey) {
      void recordAiUsage({
        requestId, provider: "unconfigured", model: aiModel || "unknown", endpoint: "/v1/chat/completions",
        status: "transport_error", latencyMs: Date.now() - startedAt, errorCode: "AI_NOT_CONFIGURED",
      });
      set.status = 503;
      return {
        error: {
          message: "AI 服务尚未配置。请先在「平台管理 → 系统设置」中填写 AI API 地址和密钥。",
          type: "configuration_error",
        },
      };
    }

    // 2. Parse the incoming request body
    const proxyBody = body as Record<string, unknown>;

    // Use configured model as fallback
    if (!proxyBody.model && aiModel) {
      proxyBody.model = aiModel;
    }

    const isStream = proxyBody.stream === true;
    const targetUrl = `${aiApiBase.replace(/\/+$/, "")}/chat/completions`;
    const provider = (() => {
      try { return hashAiProvider(new URL(aiApiBase).origin); }
      catch { return hashAiProvider(aiApiBase); }
    })();
    const model = typeof proxyBody.model === "string" && proxyBody.model ? proxyBody.model : "unknown";
    const inputRate = parseAiPricing(inputRateSetting);
    const outputRate = parseAiPricing(outputRateSetting);

    logger.info(`[ChatProxy] → ${targetUrl} model=${model} stream=${isStream}`);

    // 3. Proxy the request to upstream
    try {
      const upstreamRes = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${aiApiKey}`,
        },
        body: JSON.stringify(proxyBody),
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text();
        logger.error(`[ChatProxy] Upstream error ${upstreamRes.status}: ${errText.slice(0, 500)}`);
        void recordAiUsage({
          requestId, provider, model, endpoint: "/v1/chat/completions", status: "upstream_error",
          latencyMs: Date.now() - startedAt, errorCode: `HTTP_${upstreamRes.status}`,
        });
        set.status = upstreamRes.status;
        set.headers["Content-Type"] = "application/json";
        return errText;
      }

      // 4. Stream SSE or return JSON
      if (isStream && upstreamRes.body) {
        void recordAiUsage({
          requestId, provider, model, endpoint: "/v1/chat/completions", status: "streamed",
          latencyMs: Date.now() - startedAt, pricingRevision: inputRate !== null && outputRate !== null ? "platform-settings-v1" : null,
        });
        set.headers["Content-Type"] = "text/event-stream";
        set.headers["Cache-Control"] = "no-cache";
        set.headers["Connection"] = "keep-alive";
        return new Response(upstreamRes.body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      // Non-stream JSON response
      const responseBody = await upstreamRes.json() as unknown;
      const usage = extractAiTokenUsage(responseBody);
      void recordAiUsage({
        requestId, provider, model, endpoint: "/v1/chat/completions", status: "succeeded",
        ...usage, latencyMs: Date.now() - startedAt,
        costMicrounits: calculateAiCostMicrounits(usage, inputRate, outputRate),
        pricingRevision: inputRate !== null && outputRate !== null ? "platform-settings-v1" : null,
      });
      set.headers["Content-Type"] = "application/json";
      return responseBody;
    } catch (error: unknown) {
      logger.error("[ChatProxy] Fetch error", { error });
      void recordAiUsage({
        requestId, provider, model, endpoint: "/v1/chat/completions", status: "transport_error",
        latencyMs: Date.now() - startedAt, errorCode: "AI_UPSTREAM_FETCH_FAILED",
      });
      set.status = 502;
      return {
        error: {
          message: `无法连接到 AI 服务: ${error instanceof Error ? error.message : String(error)}`,
          type: "upstream_error",
        },
      };
    }
  })

  // ─── GET /v1/chat/usage ────────────────────────────────────────
  .get("/v1/chat/usage", {
    query: t.Object({ limit: t.Optional(t.String()) }),
    detail: { tags: ["tasks"], summary: "List AI usage ledger entries" },
  }, async ({ request, query, set }) => {
    const authError = await requireAdminAuth(request);
    if (authError) { set.status = authError.status; return authError.body; }
    const parsed = query.limit ? Number(query.limit) : 100;
    return { items: await listAiUsage(Number.isFinite(parsed) ? Math.trunc(parsed) : 100) };
  })

  // ─── POST /v1/embeddings ───────────────────────────────────────
  // Uses the same platform AI settings as chat. Refuses when ai_embedding_model
  // is unset instead of inventing vectors. Does not retrieve from Vector Buckets.
  .post("/v1/embeddings", {
    body: t.Object({
      model: t.Optional(t.String()),
      input: t.Optional(t.Union([t.String(), t.Array(t.String())])),
    }, { additionalProperties: true }),
    detail: { tags: ["tasks"], summary: "Proxy an OpenAI-compatible embeddings request" },
  }, async ({ body, set }) => {
    const [aiApiBase, aiApiKey, aiEmbeddingModel] = await Promise.all([
      getPlatformSetting("ai_api_base"),
      getPlatformSetting("ai_api_key"),
      getPlatformSetting("ai_embedding_model"),
    ]);
    const result = await handleEmbeddingRequest(
      { apiBase: aiApiBase, apiKey: aiApiKey, embeddingModel: aiEmbeddingModel },
      body,
    );
    logger.info(`[Embeddings] configured=${Boolean(aiEmbeddingModel)} status=${result.status}`);
    set.status = result.status;
    return result.body;
  })


  // ─── GET /v1/chat/config ───────────────────────────────────────
  // Returns a redacted view of current AI configuration (for frontend display)
  .get("/v1/chat/config", {
    detail: { tags: ["tasks"], summary: "Get chat proxy configuration" },
  }, async () => {
    const [aiApiBase, aiModel] = await Promise.all([
      getPlatformSetting("ai_api_base"),
      getPlatformSetting("ai_model"),
    ]);
    return {
      configured: !!(aiApiBase),
      apiBase: aiApiBase || null,
      model: aiModel || null,
    };
  });
