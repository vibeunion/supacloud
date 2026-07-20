import type { SQL } from "bun";
import { config } from "../config";
import {
  decryptSecretWithKey,
  encryptSecretWithKey,
  isEncryptedSecret,
  secretEncryptionKeyFingerprint,
} from "../utils/secret-crypto";
import { SENSITIVE_PLATFORM_SETTING_KEYS } from "../utils/platform-setting-secrets";

type SecretMigrationKeys = {
  currentKey: string;
  legacyKey?: string;
};

type Rotation = {
  storedValue: string | null;
  rotated: number;
  verified: number;
};

export type SecretKeyMigrationSummary = {
  rotated: number;
  verified: number;
};

const PROJECT_SECRET_COLUMNS = [
  "db_password_encrypted",
  "jwt_secret_encrypted",
  "service_role_key_encrypted",
  "secret_key_encrypted",
  "s3_secret_key_encrypted",
] as const;

const ENCRYPTION_SCHEME = "enc:v1";

function combinedSummary(parts: SecretKeyMigrationSummary[]): SecretKeyMigrationSummary {
  return parts.reduce(
    (summary, part) => ({
      rotated: summary.rotated + part.rotated,
      verified: summary.verified + part.verified,
    }),
    { rotated: 0, verified: 0 },
  );
}

function encryptedWithCurrentKey(plaintext: string, keys: SecretMigrationKeys): Rotation {
  const storedValue = encryptSecretWithKey(plaintext, keys.currentKey);
  if (decryptSecretWithKey(storedValue, keys.currentKey) !== plaintext) {
    throw new Error("Secret encryption round-trip verification failed");
  }
  return { storedValue, rotated: 1, verified: 1 };
}

function currentPlaintext(storedValue: string, keys: SecretMigrationKeys): string | null {
  try {
    return decryptSecretWithKey(storedValue, keys.currentKey);
  } catch (error: unknown) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function legacyPlaintext(storedValue: string, keys: SecretMigrationKeys, location: string): string {
  if (!keys.legacyKey) {
    throw new Error(`${location} is not decryptable with the current encryption key and no legacy key was provided`);
  }
  try {
    return decryptSecretWithKey(storedValue, keys.legacyKey);
  } catch (error: unknown) {
    throw new Error(`${location} is not decryptable with the current or legacy encryption key`, { cause: error });
  }
}

// Plaintext, current-key, legacy-key and malformed values are handled separately so retries are idempotent and corruption fails closed.
function rotatedStoredSecret(rawValue: unknown, keys: SecretMigrationKeys, location: string): Rotation {
  if (rawValue === null || rawValue === undefined) {
    return { storedValue: null, rotated: 0, verified: 0 };
  }
  if (typeof rawValue !== "string") {
    throw new Error(`${location} must contain a string or null secret value`);
  }
  if (!isEncryptedSecret(rawValue)) return encryptedWithCurrentKey(rawValue, keys);

  const plaintext = currentPlaintext(rawValue, keys);
  if (plaintext !== null) return { storedValue: rawValue, rotated: 0, verified: 1 };
  return encryptedWithCurrentKey(legacyPlaintext(rawValue, keys, location), keys);
}

function rotationSummary(rotations: Rotation[]): SecretKeyMigrationSummary {
  return combinedSummary(rotations.map(({ rotated, verified }) => ({ rotated, verified })));
}

function projectColumnRotations(row: Record<string, unknown>, keys: SecretMigrationKeys, ref: string) {
  return Object.fromEntries(PROJECT_SECRET_COLUMNS.map((column) => [
    column,
    rotatedStoredSecret(row[column], keys, `projects.${column}[${ref}]`),
  ])) as Record<(typeof PROJECT_SECRET_COLUMNS)[number], Rotation>;
}

async function updateProjectSecretColumns(
  db: SQL,
  ref: string,
  rotations: Record<(typeof PROJECT_SECRET_COLUMNS)[number], Rotation>,
): Promise<void> {
  await db`
    UPDATE projects SET
      db_password_encrypted = ${rotations.db_password_encrypted.storedValue},
      jwt_secret_encrypted = ${rotations.jwt_secret_encrypted.storedValue},
      service_role_key_encrypted = ${rotations.service_role_key_encrypted.storedValue},
      secret_key_encrypted = ${rotations.secret_key_encrypted.storedValue},
      s3_secret_key_encrypted = ${rotations.s3_secret_key_encrypted.storedValue},
      updated_at = NOW()
    WHERE ref = ${ref}
  `;
}

async function rotateProjectColumns(db: SQL, keys: SecretMigrationKeys): Promise<SecretKeyMigrationSummary> {
  const rows = await db`
    SELECT ref, db_password_encrypted, jwt_secret_encrypted,
           service_role_key_encrypted, secret_key_encrypted, s3_secret_key_encrypted
    FROM projects
  ` as Array<Record<string, unknown>>;
  const summaries: SecretKeyMigrationSummary[] = [];

  for (const row of rows) {
    const ref = String(row.ref);
    const rotations = projectColumnRotations(row, keys, ref);
    const summary = rotationSummary(Object.values(rotations));
    summaries.push(summary);
    if (summary.rotated === 0) continue;
    await updateProjectSecretColumns(db, ref, rotations);
  }
  return combinedSummary(summaries);
}

async function rotateProjectSecrets(db: SQL, keys: SecretMigrationKeys): Promise<SecretKeyMigrationSummary> {
  const rows = await db`SELECT id, value FROM project_secrets` as Array<Record<string, unknown>>;
  const summaries: SecretKeyMigrationSummary[] = [];
  for (const row of rows) {
    const rotation = rotatedStoredSecret(row.value, keys, `project_secrets.value[${String(row.id)}]`);
    summaries.push(rotation);
    if (rotation.rotated === 0) continue;
    await db`UPDATE project_secrets SET value = ${rotation.storedValue}, updated_at = NOW() WHERE id = ${String(row.id)}`;
  }
  return combinedSummary(summaries);
}

async function rotateControlSecrets(db: SQL, keys: SecretMigrationKeys): Promise<SecretKeyMigrationSummary> {
  const rows = await db`
    SELECT project_ref, scope, name, value_encrypted
    FROM project_control_secrets
  ` as Array<Record<string, unknown>>;
  const summaries: SecretKeyMigrationSummary[] = [];
  for (const row of rows) {
    const identity = `${String(row.project_ref)}/${String(row.scope)}/${String(row.name)}`;
    const rotation = rotatedStoredSecret(row.value_encrypted, keys, `project_control_secrets.value_encrypted[${identity}]`);
    summaries.push(rotation);
    if (rotation.rotated === 0) continue;
    await db`
      UPDATE project_control_secrets SET value_encrypted = ${rotation.storedValue}, updated_at = NOW()
      WHERE project_ref = ${String(row.project_ref)} AND scope = ${String(row.scope)} AND name = ${String(row.name)}
    `;
  }
  return combinedSummary(summaries);
}

async function rotatePlatformSettingSecrets(db: SQL, keys: SecretMigrationKeys): Promise<SecretKeyMigrationSummary> {
  const [knownSecretKey] = SENSITIVE_PLATFORM_SETTING_KEYS;
  const rows = await db`
    SELECT key, value
    FROM platform_settings
    WHERE is_secret = true OR key = ${knownSecretKey}
  ` as Array<Record<string, unknown>>;
  const summaries: SecretKeyMigrationSummary[] = [];
  for (const row of rows) {
    const key = String(row.key);
    const rotation = rotatedStoredSecret(row.value, keys, `platform_settings.value[${key}]`);
    summaries.push(rotation);
    await db`
      UPDATE platform_settings
      SET value = ${rotation.storedValue}, is_secret = true, updated_at = NOW()
      WHERE key = ${key}
    `;
  }
  return combinedSummary(summaries);
}

async function rotateWebhookSecrets(db: SQL, keys: SecretMigrationKeys): Promise<SecretKeyMigrationSummary> {
  const rows = await db`
    SELECT id, secret_encrypted, previous_secret_encrypted
    FROM project_webhooks
  ` as Array<Record<string, unknown>>;
  const summaries: SecretKeyMigrationSummary[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const current = rotatedStoredSecret(row.secret_encrypted, keys, `project_webhooks.secret_encrypted[${id}]`);
    const previous = rotatedStoredSecret(row.previous_secret_encrypted, keys, `project_webhooks.previous_secret_encrypted[${id}]`);
    const summary = rotationSummary([current, previous]);
    summaries.push(summary);
    if (summary.rotated === 0) continue;
    await db`
      UPDATE project_webhooks SET
        secret_encrypted = ${current.storedValue},
        previous_secret_encrypted = ${previous.storedValue},
        updated_at = NOW()
      WHERE id = ${id}
    `;
  }
  return combinedSummary(summaries);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rotatedTaskPayload(rawPayload: unknown, keys: SecretMigrationKeys, taskId: string) {
  const payload = recordValue(rawPayload);
  const auth = recordValue(payload?.auth);
  if (!payload || !auth) return { payload: rawPayload, summary: { rotated: 0, verified: 0 } };

  const authorization = rotatedStoredSecret(auth.authorization, keys, `project_tasks.payload.auth.authorization[${taskId}]`);
  const apikey = rotatedStoredSecret(auth.apikey, keys, `project_tasks.payload.auth.apikey[${taskId}]`);
  const summary = rotationSummary([authorization, apikey]);
  if (summary.rotated === 0) return { payload, summary };
  const rotatedAuth = { ...auth };
  if ("authorization" in auth) rotatedAuth.authorization = authorization.storedValue;
  if ("apikey" in auth) rotatedAuth.apikey = apikey.storedValue;
  return {
    payload: { ...payload, auth: rotatedAuth },
    summary,
  };
}

async function rotateTaskSecrets(db: SQL, keys: SecretMigrationKeys): Promise<SecretKeyMigrationSummary> {
  const rows = await db`
    SELECT id, payload FROM project_tasks
    WHERE payload ? 'auth'
  ` as Array<Record<string, unknown>>;
  const summaries: SecretKeyMigrationSummary[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const rotation = rotatedTaskPayload(row.payload, keys, id);
    summaries.push(rotation.summary);
    if (rotation.summary.rotated === 0) continue;
    await db`UPDATE project_tasks SET payload = ${JSON.stringify(rotation.payload)}::jsonb, updated_at = NOW() WHERE id = ${id}`;
  }
  return combinedSummary(summaries);
}

async function writeMigrationCheckpoint(
  db: SQL,
  keys: SecretMigrationKeys,
  summary: SecretKeyMigrationSummary,
): Promise<void> {
  const fingerprint = secretEncryptionKeyFingerprint(keys.currentKey);
  await db`
    INSERT INTO secret_encryption_checkpoints (
      scheme, key_fingerprint, rotated_count, verified_count
    ) VALUES (
      ${ENCRYPTION_SCHEME}, ${fingerprint}, ${summary.rotated}, ${summary.verified}
    )
    ON CONFLICT (scheme, key_fingerprint) DO NOTHING
  `;
  const [checkpoint] = await db`
    SELECT key_fingerprint
    FROM secret_encryption_checkpoints
    WHERE scheme = ${ENCRYPTION_SCHEME} AND key_fingerprint = ${fingerprint}
  `;
  if (checkpoint?.key_fingerprint !== fingerprint) {
    throw new Error("Secret encryption checkpoint read-back verification failed");
  }
}

function migrationKeys(): SecretMigrationKeys {
  return {
    currentKey: config.secretsEncryptionKey,
    legacyKey: config.legacySecretsEncryptionKey || undefined,
  };
}

function assertMigrationKeys(keys: SecretMigrationKeys): void {
  if (keys.currentKey.length < 32) {
    throw new Error("The current secret encryption key must contain at least 32 characters");
  }
  if (keys.legacyKey && keys.legacyKey === keys.currentKey) {
    throw new Error("The legacy secret encryption key must differ from the current key");
  }
}

export async function migrateLegacyEncryptedSecrets(
  db: SQL,
  keys: SecretMigrationKeys = migrationKeys(),
): Promise<SecretKeyMigrationSummary> {
  assertMigrationKeys(keys);
  return db.begin((transaction) => migrateLegacyEncryptedSecretsInTransaction(transaction, keys));
}

export async function migrateLegacyEncryptedSecretsInTransaction(
  db: SQL,
  keys: SecretMigrationKeys = migrationKeys(),
): Promise<SecretKeyMigrationSummary> {
  assertMigrationKeys(keys);
  await db.unsafe(`
    LOCK TABLE projects, project_secrets, project_control_secrets, project_webhooks,
               project_tasks, platform_settings, secret_encryption_checkpoints
    IN SHARE ROW EXCLUSIVE MODE
  `);
  const summary = combinedSummary([
    await rotateProjectColumns(db, keys),
    await rotateProjectSecrets(db, keys),
    await rotateControlSecrets(db, keys),
    await rotatePlatformSettingSecrets(db, keys),
    await rotateWebhookSecrets(db, keys),
    await rotateTaskSecrets(db, keys),
  ]);
  await writeMigrationCheckpoint(db, keys, summary);
  return summary;
}

export async function hasSecretEncryptionCheckpoint(db: SQL, currentKey: string): Promise<boolean> {
  const [table] = await db`
    SELECT to_regclass('public.secret_encryption_checkpoints') IS NOT NULL AS checkpoint_table_exists
  `;
  if (table?.checkpoint_table_exists !== true) return false;
  const fingerprint = secretEncryptionKeyFingerprint(currentKey);
  const [checkpoint] = await db`
    SELECT 1 AS present
    FROM secret_encryption_checkpoints
    WHERE scheme = ${ENCRYPTION_SCHEME} AND key_fingerprint = ${fingerprint}
  `;
  return checkpoint?.present === 1;
}
