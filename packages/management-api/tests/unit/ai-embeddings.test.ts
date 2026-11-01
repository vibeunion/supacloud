import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_RESPONSE_BYTE_LIMIT,
  handleEmbeddingRequest,
  ragRetrievalPlan,
  readEmbeddingResponse,
} from "../../src/services/ai-embeddings";
import type { safeOutboundFetch } from "../../src/utils/outbound-http";

const settings = {
  apiBase: "https://api.example.com/v1",
  apiKey: "sk-test",
  embeddingModel: "text-embedding-3-small",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("governed embedding seam", () => {
  test("does not call a provider or invent a vector when settings are missing", async () => {
    let called = false;
    const fetchImpl: typeof safeOutboundFetch = async () => {
      called = true;
      return jsonResponse({});
    };
    const result = await handleEmbeddingRequest(
      { apiBase: "https://api.example.com/v1", apiKey: "sk-test", embeddingModel: "" },
      { input: "hello" },
      fetchImpl,
    );
    expect(called).toBe(false);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: {
        available: false,
        capability: "embeddings",
        missing: ["ai_embedding_model"],
        synthesizedVector: false,
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("float32");
  });

  test("rejects a caller-selected model, a private endpoint, and an empty provider payload", async () => {
    const calls: Array<{ url: string; maxResponseBytes?: number; body?: string }> = [];
    const fetchImpl: typeof safeOutboundFetch = async (url, init, options) => {
      calls.push({
        url,
        maxResponseBytes: options?.maxResponseBytes,
        body: typeof init.body === "string" ? init.body : undefined,
      });
      return jsonResponse({ data: [] });
    };

    expect((await handleEmbeddingRequest(settings, { model: "other-model", input: "hello" }, fetchImpl)).status)
      .toBe(400);
    expect((await handleEmbeddingRequest(
      { ...settings, apiBase: "http://127.0.0.1:9/v1" },
      { input: "hello" },
      fetchImpl,
    )).status).toBe(400);
    const empty = await handleEmbeddingRequest(settings, { input: "hello" }, fetchImpl);
    expect(empty.status).toBe(502);
    expect(JSON.stringify(empty.body)).not.toContain("[0,0,0]");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.com/v1/embeddings");
    expect(calls[0]?.maxResponseBytes).toBe(EMBEDDING_RESPONSE_BYTE_LIMIT);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
    });
  });

  test("returns provider vectors and does not claim retrieval", async () => {
    const fetchImpl: typeof safeOutboundFetch = async () => jsonResponse({
      data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
    });
    const result = await handleEmbeddingRequest(settings, { input: ["a", "b"] }, fetchImpl);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      model: "text-embedding-3-small",
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1] },
      ],
      rag: { status: "ann_query", retrievalExecuted: false, synthesizedVector: false, queryEngine: "pgvector-ann" },
    });
  });

  test("rejects invalid provider vectors instead of filling them in", () => {
    expect(readEmbeddingResponse({ data: [{ embedding: [1, Number.NaN] }] })).toEqual({
      error: "embedding response contained an invalid vector",
    });
  });

  test("plans text RAG as a later embedding call and does not synthesize a vector", () => {
    const plan = ragRetrievalPlan({
      vectorBucketName: "embeddings",
      indexName: "documents",
      queryText: "where is the contract?",
    });
    expect(plan.status).toBe("embed_then_ann_query");
    expect(plan.synthesizedVector).toBe(false);
    expect(plan.retrievalExecuted).toBe(false);
    expect(plan.embedding?.settings).toContain("ai_embedding_model");
    expect(JSON.stringify(plan)).not.toContain("float32");
    expect(ragRetrievalPlan({ queryVector: { float32: [1, 0] } }).status).toBe("ann_query");
    expect(ragRetrievalPlan({}).status).toBe("unavailable");
  });
});
