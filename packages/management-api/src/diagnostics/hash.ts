import { createHash } from "node:crypto";
import type { DiagnosticContext, ResultStatus } from "../services/diagnostics.types";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export async function statusForHash(
  ctx: DiagnosticContext,
  checkId: string,
  hash: string,
): Promise<{ status: ResultStatus; baselineHash: string | null }> {
  const baselineHash = await ctx.getBaselineHash?.(checkId) ?? null;
  return {
    status: baselineHash && baselineHash !== hash ? "tampered" : "pass",
    baselineHash,
  };
}
