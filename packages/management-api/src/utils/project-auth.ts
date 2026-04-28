import { sql as metaSql } from "../db";

export async function resolveProjectRefFromApiKey(key: string): Promise<string | null> {
  if (!key) return null;
  try {
    const rows = await metaSql`SELECT ref FROM projects WHERE anon_key = ${key} OR service_role_key = ${key} LIMIT 1`;
    if (rows.length > 0) return String(rows[0].ref);
  } catch {}
  return null;
}

export function extractProjectRefFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/projects\/([^/]+)(?:\/|$)/);
  return match?.[1] || null;
}

export function extractProjectRefCandidates(
  payload: Record<string, unknown>,
  scopedRef?: string | null,
): string[] {
  const refs = new Set<string>();

  if (scopedRef) {
    refs.add(scopedRef);
  }

  if (typeof payload.ref === "string" && payload.ref.trim()) {
    refs.add(payload.ref.trim());
  }

  const refFromIss = normalizeRefFromIssuer(payload.iss);
  if (refFromIss) {
    refs.add(refFromIss);
  }

  return [...refs];
}

function normalizeRefFromIssuer(iss: unknown): string | null {
  if (typeof iss !== "string" || !iss.trim()) return null;

  const hostLike = iss.replace(/^https?:\/\//, "").split("/")[0];
  const firstLabel = hostLike.split(".")[0]?.trim();

  if (!firstLabel) return null;
  if (firstLabel === "supabase" || firstLabel === "supacloud") return null;

  return firstLabel;
}
