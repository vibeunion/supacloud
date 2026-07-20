import type { SQL } from "bun";
import { sql } from "../db";
import { decryptSecretIfNeeded, encryptSecretIfNeeded } from "../utils/secret-crypto";
import {
  isMaskedPlatformSecret,
  isSensitivePlatformSetting,
} from "../utils/platform-setting-secrets";

const MASKED_SECRET = "********";

type StoredPlatformSetting = {
  key: string;
  value: string;
  description: string | null;
  is_secret: boolean;
  updated_at: string | Date;
};

export type PlatformSettingInput = {
  key: string;
  value: string;
  description?: string | null;
  is_secret?: boolean;
};

export type SafePlatformSetting = Omit<StoredPlatformSetting, "value"> & {
  value: string;
  configured: boolean;
};

function safeSetting(row: StoredPlatformSetting): SafePlatformSetting {
  return {
    ...row,
    value: row.is_secret ? MASKED_SECRET : row.value,
    configured: row.is_secret ? Boolean(row.value) : true,
  };
}

async function storedValueForUpdate(
  db: SQL,
  input: PlatformSettingInput,
): Promise<{ value: string; isSecret: boolean }> {
  const [existing] = await db`
    SELECT value, is_secret
    FROM platform_settings
    WHERE key = ${input.key}
    FOR UPDATE
  ` as Array<Pick<StoredPlatformSetting, "value" | "is_secret">>;
  const isSecret = isSensitivePlatformSetting(input.key)
    || input.is_secret === true
    || existing?.is_secret === true;
  if (!isSecret) return { value: input.value, isSecret: false };
  if (isMaskedPlatformSecret(input.value)) {
    if (!existing?.value) throw new Error(`Masked value cannot create platform secret ${input.key}`);
    return { value: encryptSecretIfNeeded(existing.value), isSecret: true };
  }
  return { value: encryptSecretIfNeeded(input.value), isSecret: true };
}

async function upsertSetting(db: SQL, input: PlatformSettingInput): Promise<void> {
  const stored = await storedValueForUpdate(db, input);
  await db`
    INSERT INTO platform_settings (key, value, description, is_secret, updated_at)
    VALUES (${input.key}, ${stored.value}, ${input.description ?? null}, ${stored.isSecret}, NOW())
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(EXCLUDED.description, platform_settings.description),
        is_secret = platform_settings.is_secret OR EXCLUDED.is_secret,
        updated_at = NOW()
  `;
}

export async function listPlatformSettings(): Promise<SafePlatformSetting[]> {
  const rows = await sql`
    SELECT key, value, description, is_secret, updated_at
    FROM platform_settings
    ORDER BY key
  ` as StoredPlatformSetting[];
  return rows.map(safeSetting);
}

export async function getSafePlatformSetting(key: string): Promise<SafePlatformSetting | null> {
  const [row] = await sql`
    SELECT key, value, description, is_secret, updated_at
    FROM platform_settings
    WHERE key = ${key}
  ` as StoredPlatformSetting[];
  return row ? safeSetting(row) : null;
}

export async function updatePlatformSettings(inputs: PlatformSettingInput[]): Promise<number> {
  await sql.begin(async (transaction) => {
    for (const input of inputs) await upsertSetting(transaction, input);
  });
  return inputs.length;
}

export async function getPlatformSetting(key: string): Promise<string> {
  const [row] = await sql`
    SELECT value, is_secret
    FROM platform_settings
    WHERE key = ${key}
  ` as Array<Pick<StoredPlatformSetting, "value" | "is_secret">>;
  if (!row) return "";
  return row.is_secret ? decryptSecretIfNeeded(row.value) : row.value;
}

export const platformSettingsService = {
  list: listPlatformSettings,
  getSafe: getSafePlatformSetting,
  update: updatePlatformSettings,
};
