import { Elysia, t } from "elysia";
import { logger } from "../utils/logger";
import { getPlatformSetting } from "../services/platform-settings.service";

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
  .post("/v1/chat/completions", async ({ body, set }) => {
    // 1. Read dynamic config from DB
    const [aiApiBase, aiApiKey, aiModel] = await Promise.all([
      getPlatformSetting("ai_api_base"),
      getPlatformSetting("ai_api_key"),
      getPlatformSetting("ai_model"),
    ]);

    if (!aiApiBase || !aiApiKey) {
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

    logger.info(`[ChatProxy] → ${targetUrl} model=${proxyBody.model} stream=${isStream}`);

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
        set.status = upstreamRes.status;
        set.headers["Content-Type"] = "application/json";
        return errText;
      }

      // 4. Stream SSE or return JSON
      if (isStream && upstreamRes.body) {
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
      set.headers["Content-Type"] = "application/json";
      return upstreamRes.json();
    } catch (error: unknown) {
      logger.error("[ChatProxy] Fetch error", { error });
      set.status = 502;
      return {
        error: {
          message: `无法连接到 AI 服务: ${error instanceof Error ? error.message : String(error)}`,
          type: "upstream_error",
        },
      };
    }
  }, {
    body: t.Object({
      model: t.Optional(t.String()),
      stream: t.Optional(t.Boolean())
    }, { additionalProperties: true }),
    detail: { tags: ["tasks"], summary: "Proxy chat completion request" },
  })

  // ─── GET /v1/chat/config ───────────────────────────────────────
  // Returns a redacted view of current AI configuration (for frontend display)
  .get("/v1/chat/config", async () => {
    const [aiApiBase, aiModel] = await Promise.all([
      getPlatformSetting("ai_api_base"),
      getPlatformSetting("ai_model"),
    ]);
    return {
      configured: !!(aiApiBase),
      apiBase: aiApiBase || null,
      model: aiModel || null,
    };
  }, {
    detail: { tags: ["tasks"], summary: "Get chat proxy configuration" },
  });
