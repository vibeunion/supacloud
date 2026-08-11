import type { DiagnosticContext, ResultStatus } from "../services/diagnostics.types";
import { stableSha256, stableStringify } from "../utils/stable-json";

export { stableStringify } from "../utils/stable-json";

export function hashPayload(value: unknown): string {
  return stableSha256(value);
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
