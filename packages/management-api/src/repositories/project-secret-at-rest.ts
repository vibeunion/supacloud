import type { SQL } from "bun";
import { hashSecretApiKey } from "../utils/api-keys";
import { decryptSecretIfNeeded, encryptSecretIfNeeded } from "../utils/secret-crypto";

const SECRET_FIELDS = [
  ["db_password", "db_password_encrypted"],
  ["jwt_secret", "jwt_secret_encrypted"],
  ["anon_key", "anon_key_encrypted"],
  ["service_role_key", "service_role_key_encrypted"],
  ["s3_secret_key", "s3_secret_key_encrypted"],
] as const;

export type ProjectSecretInput = {
  db_password: string;
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
  s3_secret_key?: string | null;
};

export type SealedProjectSecrets = {
  db_password: null;
  jwt_secret: null;
  anon_key: null;
  service_role_key: null;
  s3_secret_key: null;
  db_password_encrypted: string;
  jwt_secret_encrypted: string;
  anon_key_encrypted: string;
  service_role_key_encrypted: string;
  s3_secret_key_encrypted: string | null;
  anon_key_hash: string;
  service_role_key_hash: string;
};

function presentSecret(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sealPlaintext(plaintext: string, label: string): string {
  const stored = encryptSecretIfNeeded(plaintext);
  if (decryptSecretIfNeeded(stored) !== plaintext) {
    throw new Error(`${label} encryption round-trip failed`);
  }
  return stored;
}

export function sealRotatedApiKeys(keys: {
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
}): Pick<SealedProjectSecrets, "jwt_secret_encrypted" | "anon_key_encrypted" | "service_role_key_encrypted" | "anon_key_hash" | "service_role_key_hash"> {
  return {
    jwt_secret_encrypted: sealPlaintext(keys.jwt_secret, "jwt_secret"),
    anon_key_encrypted: sealPlaintext(keys.anon_key, "anon_key"),
    service_role_key_encrypted: sealPlaintext(keys.service_role_key, "service_role_key"),
    anon_key_hash: hashSecretApiKey(keys.anon_key),
    service_role_key_hash: hashSecretApiKey(keys.service_role_key),
  };
}

export function sealProjectSecrets(input: ProjectSecretInput): SealedProjectSecrets {
  return {
    db_password: null,
    jwt_secret: null,
    anon_key: null,
    service_role_key: null,
    s3_secret_key: null,
    db_password_encrypted: sealPlaintext(input.db_password, "db_password"),
    jwt_secret_encrypted: sealPlaintext(input.jwt_secret, "jwt_secret"),
    anon_key_encrypted: sealPlaintext(input.anon_key, "anon_key"),
    service_role_key_encrypted: sealPlaintext(input.service_role_key, "service_role_key"),
    s3_secret_key_encrypted: input.s3_secret_key ? sealPlaintext(input.s3_secret_key, "s3_secret_key") : null,
    anon_key_hash: hashSecretApiKey(input.anon_key),
    service_role_key_hash: hashSecretApiKey(input.service_role_key),
  };
}

// Encrypted columns win. A plaintext column is only a legacy source when its
// encrypted twin is empty, so a cleared row cannot fall back to stale cleartext.
export function revealProjectSecrets<T extends object>(row: T): T {
  const source = row as Record<string, unknown>;
  const revealed: Record<string, unknown> = { ...source };
  for (const [plain, encrypted] of SECRET_FIELDS) {
    if (!Object.hasOwn(source, encrypted) && !Object.hasOwn(source, plain)) continue;
    const ciphertext = presentSecret(source[encrypted]);
    if (ciphertext) {
      revealed[plain] = decryptSecretIfNeeded(ciphertext);
    }
  }
  return revealed as T;
}

export type ClearedProjectSecrets = {
  db_password_encrypted: string | null;
  jwt_secret_encrypted: string | null;
  anon_key_encrypted: string | null;
  service_role_key_encrypted: string | null;
  s3_secret_key_encrypted: string | null;
  anon_key_hash: string | null;
  service_role_key_hash: string | null;
};

function storedSecret(row: Record<string, unknown>, plain: string, encrypted: string): string | null {
  const plaintext = presentSecret(row[plain]);
  const ciphertext = presentSecret(row[encrypted]);
  if (plaintext) return sealPlaintext(plaintext, plain);
  if (!ciphertext) return null;
  decryptSecretIfNeeded(ciphertext);
  return ciphertext;
}

// Returns null when the row already stores only ciphertext and lookup hashes.
// A non-null plaintext column is the value current readers use, so it replaces
// a divergent ciphertext before the plaintext column is cleared.
export function clearedProjectSecretWrite(row: Record<string, unknown>): ClearedProjectSecrets | null {
  const next: ClearedProjectSecrets = {
    db_password_encrypted: storedSecret(row, "db_password", "db_password_encrypted"),
    jwt_secret_encrypted: storedSecret(row, "jwt_secret", "jwt_secret_encrypted"),
    anon_key_encrypted: storedSecret(row, "anon_key", "anon_key_encrypted"),
    service_role_key_encrypted: storedSecret(row, "service_role_key", "service_role_key_encrypted"),
    s3_secret_key_encrypted: storedSecret(row, "s3_secret_key", "s3_secret_key_encrypted"),
    anon_key_hash: null,
    service_role_key_hash: null,
  };
  const anon = next.anon_key_encrypted ? decryptSecretIfNeeded(next.anon_key_encrypted) : null;
  const serviceRole = next.service_role_key_encrypted
    ? decryptSecretIfNeeded(next.service_role_key_encrypted)
    : null;
  next.anon_key_hash = anon ? hashSecretApiKey(anon) : null;
  next.service_role_key_hash = serviceRole ? hashSecretApiKey(serviceRole) : null;

  const plaintextRemains = SECRET_FIELDS.some(([plain]) => presentSecret(row[plain]) !== null);
  const ciphertextChanged = SECRET_FIELDS.some(([, encrypted]) => (
    presentSecret(row[encrypted]) !== next[encrypted]
  ));
  const hashChanged = presentSecret(row["anon_key_hash"]) !== next.anon_key_hash
    || presentSecret(row["service_role_key_hash"]) !== next.service_role_key_hash;
  if (!plaintextRemains && !ciphertextChanged && !hashChanged) return null;
  return next;
}

export async function migratePlaintextProjectSecrets(db: SQL): Promise<number> {
  const rows = await db`
    SELECT ref, db_password, jwt_secret, anon_key, service_role_key, s3_secret_key,
           db_password_encrypted, jwt_secret_encrypted, anon_key_encrypted,
           service_role_key_encrypted, s3_secret_key_encrypted,
           anon_key_hash, service_role_key_hash
    FROM projects
    WHERE db_password IS NOT NULL
       OR jwt_secret IS NOT NULL
       OR anon_key IS NOT NULL
       OR service_role_key IS NOT NULL
       OR s3_secret_key IS NOT NULL
       OR (anon_key_encrypted IS NOT NULL AND anon_key_hash IS NULL)
       OR (service_role_key_encrypted IS NOT NULL AND service_role_key_hash IS NULL)
  ` as Array<Record<string, unknown>>;

  let updated = 0;
  for (const row of rows) {
    const next = clearedProjectSecretWrite(row);
    if (!next) continue;
    await db`
      UPDATE projects
      SET db_password = NULL,
          jwt_secret = NULL,
          anon_key = NULL,
          service_role_key = NULL,
          s3_secret_key = NULL,
          db_password_encrypted = ${next.db_password_encrypted},
          jwt_secret_encrypted = ${next.jwt_secret_encrypted},
          anon_key_encrypted = ${next.anon_key_encrypted},
          service_role_key_encrypted = ${next.service_role_key_encrypted},
          s3_secret_key_encrypted = ${next.s3_secret_key_encrypted},
          anon_key_hash = ${next.anon_key_hash},
          service_role_key_hash = ${next.service_role_key_hash},
          updated_at = NOW()
      WHERE ref = ${String(row["ref"])}
    `;
    updated += 1;
  }
  return updated;
}
