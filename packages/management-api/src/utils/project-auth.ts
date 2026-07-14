import { sql as metaSql } from "../db";
import { hashSecretApiKey } from "./api-keys";

export type ProjectApiKeyKind = "anon" | "service_role" | "publishable" | "secret";

export type ResolvedProjectApiKey = {
  ref: string;
  kind: ProjectApiKeyKind;
  role: "anon" | "service_role";
  upstreamKey: string;
};

type ProjectApiKeyLookupOptions = {
  includeProvisioning?: boolean;
};

type ProjectApiKeyRow = {
  ref?: unknown;
  anon_key?: unknown;
  service_role_key?: unknown;
  publishable_key?: unknown;
  secret_key_hash?: unknown;
};

function buildApiKeyLookup(key: string, options: ProjectApiKeyLookupOptions = {}) {
  const statusSql = options.includeProvisioning
    ? "lower(status) IN ('active', 'creating')"
    : "lower(status) = 'active'";
  const secretHash = hashSecretApiKey(key);

  return {
    query: `
      SELECT ref, anon_key, service_role_key, publishable_key, secret_key_hash
      FROM projects
      WHERE deleted_at IS NULL
        AND ${statusSql}
        AND (
          anon_key = $1
          OR service_role_key = $1
          OR publishable_key = $1
          OR secret_key_hash = $2
        )
      LIMIT 1
    `,
    params: [key, secretHash] as [string, string],
    secretHash,
  };
}

function resolveApiKeyRow(
  key: string,
  secretHash: string,
  row: ProjectApiKeyRow | undefined,
): ResolvedProjectApiKey | null {
  if (!row) return null;

  const ref = String(row.ref);
  const anonKey = String(row.anon_key || "");
  const serviceRoleKey = String(row.service_role_key || "");
  if (key === row.publishable_key) {
    return { ref, kind: "publishable", role: "anon", upstreamKey: anonKey };
  }
  if (secretHash === row.secret_key_hash) {
    return { ref, kind: "secret", role: "service_role", upstreamKey: serviceRoleKey };
  }
  if (key === anonKey) {
    return { ref, kind: "anon", role: "anon", upstreamKey: anonKey };
  }
  if (key === serviceRoleKey) {
    return { ref, kind: "service_role", role: "service_role", upstreamKey: serviceRoleKey };
  }
  return null;
}

export const projectAuthInternals = {
  buildApiKeyLookup,
  resolveApiKeyRow,
};

export async function resolveProjectApiKey(
  key: string,
  options: ProjectApiKeyLookupOptions = {},
): Promise<ResolvedProjectApiKey | null> {
  if (!key) return null;

  const lookup = buildApiKeyLookup(key, options);

  try {
    const rows = await metaSql.unsafe(lookup.query, lookup.params);
    return resolveApiKeyRow(key, lookup.secretHash, rows[0] as ProjectApiKeyRow | undefined);
  } catch {
    // Rolling upgrades may briefly run before the additive opaque-key columns
    // exist. Preserve legacy key lookup until initDatabase finishes.
    try {
      const rows = options.includeProvisioning
        ? await metaSql`
          SELECT ref, anon_key, service_role_key FROM projects
          WHERE (anon_key = ${key} OR service_role_key = ${key})
            AND deleted_at IS NULL
            AND lower(status) IN ('active', 'creating')
          LIMIT 1
        `
        : await metaSql`
          SELECT ref, anon_key, service_role_key FROM projects
          WHERE (anon_key = ${key} OR service_role_key = ${key})
            AND deleted_at IS NULL
            AND lower(status) = 'active'
          LIMIT 1
        `;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const ref = String(row.ref);
      if (key === row.anon_key) {
        return { ref, kind: "anon", role: "anon", upstreamKey: key };
      }
      return { ref, kind: "service_role", role: "service_role", upstreamKey: key };
    } catch {
      return null;
    }
  }

  return null;
}

export async function resolveProjectRefFromApiKey(
  key: string,
  options: { includeProvisioning?: boolean } = {},
): Promise<string | null> {
  return (await resolveProjectApiKey(key, options))?.ref || null;
}

export function extractProjectRefFromPath(pathname: string): string | null {
  return (
    pathname.match(/^\/v1\/projects\/([^/]+)(?:\/|$)/)?.[1] ||
    pathname.match(/^\/v1\/storage\/([^/]+)(?:\/|$)/)?.[1] ||
    null
  );
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
