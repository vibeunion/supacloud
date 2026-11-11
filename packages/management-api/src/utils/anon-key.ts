import { decodeProtectedHeader, jwtVerify } from "jose";
import { decryptSecretIfNeeded } from "./secret-crypto";

export type StoredAnonKeyCredential = {
  anon_key?: string | null;
  anon_key_encrypted?: string | null;
  jwt_secret?: string | null;
};

function isJwtLike(value: string | null | undefined): value is string {
  return typeof value === "string" && value.split(".").length === 3;
}

export function resolveStoredAnonKey(
  project: StoredAnonKeyCredential,
): string | null {
  if (isJwtLike(project.anon_key)) return project.anon_key;
  if (!project.anon_key_encrypted) return project.anon_key || null;

  const decryptedKey = decryptSecretIfNeeded(project.anon_key_encrypted);
  return decryptedKey || project.anon_key || null;
}

/**
 * Check the legacy anon key against the project's current JWT secret.
 * Non-HS256 and opaque compatibility credentials are left untouched because
 * they are validated by their own consumers or belong to older fixtures.
 */
export async function isStoredAnonKeyAligned(
  project: StoredAnonKeyCredential,
): Promise<boolean> {
  const key = resolveStoredAnonKey(project);
  if (!key) return false;

  let header: { alg?: unknown };
  try {
    header = decodeProtectedHeader(key);
  } catch {
    return true;
  }

  if (header.alg !== "HS256") return true;
  if (!project.jwt_secret) return false;

  try {
    const { payload } = await jwtVerify(
      key,
      new TextEncoder().encode(project.jwt_secret),
      { algorithms: ["HS256"] },
    );
    const issuer = payload["iss"];
    return (
      payload["role"] === "anon" &&
      (issuer === "supabase" || issuer === "supabase-demo")
    );
  } catch {
    return false;
  }
}

/**
 * Resolve a legacy anon key suitable for runtime use. Callers that need a
 * durable repair must persist the returned value with updateApiKeys.
 */
export async function resolveAlignedAnonKey(
  project: StoredAnonKeyCredential,
): Promise<string | null> {
  const stored = resolveStoredAnonKey(project);
  if (stored && await isStoredAnonKeyAligned(project)) return stored;
  if (!project.jwt_secret) return null;

  const { jwtService } = await import("../services/jwt.service");
  return jwtService.generateAnonKey(project.jwt_secret);
}
