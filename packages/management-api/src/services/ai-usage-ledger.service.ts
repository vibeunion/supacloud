import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { sql } from "../db";

export type AiUsageStatus = "succeeded" | "streamed" | "upstream_error" | "transport_error";

export type AiUsage = {
  requestId: string;
  provider: string;
  model: string;
  endpoint: string;
  status: AiUsageStatus;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  latencyMs: number;
  costMicrounits?: number | null;
  pricingRevision?: string | null;
  errorCode?: string | null;
};

export type AiTokenUsage = Pick<AiUsage, "promptTokens" | "completionTokens" | "totalTokens">;

let schemaReady: Promise<void> | null = null;

export function hashAiProvider(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function extractAiTokenUsage(value: unknown): AiTokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const row = usage as Record<string, unknown>;
  const read = (key: string): number | null => {
    const candidate = row[key];
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  };
  const promptTokens = read("prompt_tokens");
  const completionTokens = read("completion_tokens");
  const totalTokens = read("total_tokens");
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

export function calculateAiCostMicrounits(
  usage: AiTokenUsage | null,
  inputMicrounitsPerMillion: number | null,
  outputMicrounitsPerMillion: number | null,
): number | null {
  if (!usage || inputMicrounitsPerMillion === null || outputMicrounitsPerMillion === null) return null;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const cost = (prompt * inputMicrounitsPerMillion + completion * outputMicrounitsPerMillion) / 1_000_000;
  return Number.isSafeInteger(Math.round(cost)) ? Math.max(0, Math.round(cost)) : null;
}

export function parseAiPricing(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function ensureSchema(db: SQL = sql): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.unsafe(`
      CREATE TABLE IF NOT EXISTS ai_usage_ledger (
        request_id text PRIMARY KEY CHECK (request_id ~ '^[A-Za-z0-9_.:@/-]{8,200}$'),
        provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 200),
        model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
        endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 500),
        status text NOT NULL CHECK (status IN ('succeeded', 'streamed', 'upstream_error', 'transport_error')),
        prompt_tokens bigint CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
        completion_tokens bigint CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
        total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
        latency_ms integer NOT NULL CHECK (latency_ms >= 0),
        cost_microunits bigint CHECK (cost_microunits IS NULL OR cost_microunits >= 0),
        pricing_revision text,
        error_code text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `).then(() => undefined).catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function recordAiUsage(entry: AiUsage): Promise<boolean> {
  try {
    await ensureSchema();
    await sql`
      INSERT INTO ai_usage_ledger (
        request_id, provider, model, endpoint, status,
        prompt_tokens, completion_tokens, total_tokens,
        latency_ms, cost_microunits, pricing_revision, error_code
      ) VALUES (
        ${entry.requestId}, ${entry.provider}, ${entry.model}, ${entry.endpoint}, ${entry.status},
        ${entry.promptTokens ?? null}, ${entry.completionTokens ?? null}, ${entry.totalTokens ?? null},
        ${Math.max(0, Math.round(entry.latencyMs))}, ${entry.costMicrounits ?? null},
        ${entry.pricingRevision ?? null}, ${entry.errorCode ?? null}
      )
      ON CONFLICT (request_id) DO NOTHING
    `;
    return true;
  } catch {
    return false;
  }
}

export async function listAiUsage(limit = 100): Promise<unknown[]> {
  const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
  await ensureSchema();
  return await sql`
    SELECT request_id, provider, model, endpoint, status,
           prompt_tokens, completion_tokens, total_tokens,
           latency_ms, cost_microunits, pricing_revision, error_code, created_at
    FROM ai_usage_ledger
    ORDER BY created_at DESC
    LIMIT ${bounded}
  `;
}
