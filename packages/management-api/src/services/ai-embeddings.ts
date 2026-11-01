import { safeOutboundFetch, validateOutboundHttpUrl } from "../utils/outbound-http";

/**
 * Governed embedding seam for the existing platform AI settings.
 *
 * Chat completions already read `ai_api_base` and `ai_api_key`. Embeddings use
 * those same settings plus `ai_embedding_model`. Nothing in this module invents
 * vectors, and `LLM_ENDPOINT` / `LLM_API_KEY` / `LLM_MODEL` are not consulted.
 */

export const EMBEDDING_PLATFORM_SETTINGS = ["ai_api_base", "ai_api_key", "ai_embedding_model"] as const;
export const EMBEDDING_RESPONSE_BYTE_LIMIT = 1_048_576;
export const MAX_EMBEDDING_INPUTS = 16;
export const MAX_EMBEDDING_INPUT_CHARS = 8_000;

export type EmbeddingSettings = {
  apiBase: string;
  apiKey: string;
  embeddingModel: string;
};

export type RagRetrievalPlan = {
  status: "ann_query" | "embed_then_ann_query" | "unavailable";
  synthesizedVector: false;
  queryEngine: "pgvector-ann";
  retrievalExecuted: false;
  vectorBucketName?: string;
  indexName?: string;
  topK?: number;
  queryText?: string;
  embedding: {
    provider: "platform_settings";
    settings: typeof EMBEDDING_PLATFORM_SETTINGS;
    endpoint: "POST /v1/embeddings";
  } | null;
  reason?: string;
};

export function embeddingProviderRequiredMessage(): string {
  return "QueryVectors accepts a float32 queryVector and runs pgvector ANN. It does not embed text. Configure platform settings ai_api_base, ai_api_key, and ai_embedding_model, call POST /v1/embeddings, then pass the returned float32 vector. SupaCloud does not synthesize embeddings.";
}

export function ragRetrievalPlan(input: {
  vectorBucketName?: string;
  indexName?: string;
  topK?: number;
  queryVector?: { float32?: unknown };
  queryText?: unknown;
}): RagRetrievalPlan {
  const base = {
    synthesizedVector: false as const,
    queryEngine: "pgvector-ann" as const,
    retrievalExecuted: false as const,
    vectorBucketName: input.vectorBucketName,
    indexName: input.indexName,
    topK: input.topK,
  };
  const floats = input.queryVector?.float32;
  if (Array.isArray(floats) && floats.length > 0) {
    return { ...base, status: "ann_query", embedding: null };
  }
  if (typeof input.queryText === "string" && input.queryText.trim()) {
    return {
      ...base,
      status: "embed_then_ann_query",
      queryText: input.queryText,
      embedding: {
        provider: "platform_settings",
        settings: EMBEDDING_PLATFORM_SETTINGS,
        endpoint: "POST /v1/embeddings",
      },
      reason: "text_requires_configured_embedding_model",
    };
  }
  return {
    ...base,
    status: "unavailable",
    embedding: null,
    reason: "query_vector_or_text_required",
  };
}

export type EmbeddingHttpResult = { status: number; body: unknown };

function missingSettings(settings: EmbeddingSettings): string[] {
  const missing: string[] = [];
  if (!settings.apiBase.trim()) missing.push("ai_api_base");
  if (!settings.apiKey.trim()) missing.push("ai_api_key");
  if (!settings.embeddingModel.trim()) missing.push("ai_embedding_model");
  return missing;
}

function configurationGap(missing: string[]): EmbeddingHttpResult {
  return {
    status: 503,
    body: {
      error: {
        message: "No embedding provider is configured. Set platform settings ai_api_base, ai_api_key, and ai_embedding_model. SupaCloud does not synthesize embeddings. LLM_ENDPOINT, LLM_API_KEY, and LLM_MODEL are not an embedding provider and are not used.",
        type: "configuration_error",
        capability: "embeddings",
        available: false,
        missing,
        synthesizedVector: false,
      },
    },
  };
}

function embeddingError(status: number, message: string, type: string): EmbeddingHttpResult {
  return {
    status,
    body: {
      error: {
        message,
        type,
        capability: "embeddings",
        available: false,
        synthesizedVector: false,
      },
    },
  };
}

function readEmbeddingInput(body: unknown, embeddingModel: string): { model: string; input: string[] } | EmbeddingHttpResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return embeddingError(400, "embedding request body must be an object", "invalid_request_error");
  }
  const record = body as Record<string, unknown>;
  if (record.model !== undefined && record.model !== embeddingModel) {
    return embeddingError(400, "embedding model is governed by platform setting ai_embedding_model", "invalid_request_error");
  }
  const raw = record.input;
  const inputs = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_EMBEDDING_INPUTS
    || inputs.some((item) => typeof item !== "string" || item.length < 1 || item.length > MAX_EMBEDDING_INPUT_CHARS)) {
    return embeddingError(
      400,
      `input must be a string or 1-${MAX_EMBEDDING_INPUTS} strings of 1-${MAX_EMBEDDING_INPUT_CHARS} characters. Token-id inputs are not accepted.`,
      "invalid_request_error",
    );
  }
  return { model: embeddingModel, input: inputs };
}

export function readEmbeddingResponse(payload: unknown): { embeddings: number[][] } | { error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "embedding response was not a JSON object" };
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return { error: "embedding response did not include vectors" };
  const rows = data.map((entry, position) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as { index?: unknown; embedding?: unknown };
    const index = typeof record.index === "number" ? record.index : position;
    const embedding = record.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0
      || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return null;
    }
    return { index, embedding };
  });
  if (rows.some((row) => row === null)) return { error: "embedding response contained an invalid vector" };
  return {
    embeddings: rows
      .filter((row): row is { index: number; embedding: number[] } => row !== null)
      .sort((left, right) => left.index - right.index)
      .map((row) => row.embedding),
  };
}

export async function handleEmbeddingRequest(
  settings: EmbeddingSettings,
  body: unknown,
  fetchImpl: typeof safeOutboundFetch = safeOutboundFetch,
): Promise<EmbeddingHttpResult> {
  const missing = missingSettings(settings);
  if (missing.length > 0) return configurationGap(missing);
  const planned = readEmbeddingInput(body, settings.embeddingModel.trim());
  if ("status" in planned) return planned;
  const url = `${settings.apiBase.trim().replace(/\/+$/, "")}/embeddings`;
  const validated = validateOutboundHttpUrl(url);
  if (!validated.ok) {
    return embeddingError(400, `embedding endpoint was rejected: ${validated.error}`, "invalid_request_error");
  }
  let response: Response;
  try {
    response = await fetchImpl(validated.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model: planned.model, input: planned.input }),
    }, { maxResponseBytes: EMBEDDING_RESPONSE_BYTE_LIMIT });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return embeddingError(502, `embedding request failed: ${message}`, "upstream_error");
  }
  if (!response.ok) {
    return embeddingError(response.status, "embedding provider rejected the request", "upstream_error");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return embeddingError(502, "embedding provider returned unreadable JSON", "upstream_error");
  }
  const parsed = readEmbeddingResponse(payload);
  if ("error" in parsed) return embeddingError(502, parsed.error, "upstream_error");
  return {
    status: 200,
    body: {
      object: "list",
      model: planned.model,
      data: parsed.embeddings.map((embedding, index) => ({ object: "embedding", index, embedding })),
      rag: ragRetrievalPlan({ queryVector: { float32: parsed.embeddings[0] } }),
    },
  };
}
