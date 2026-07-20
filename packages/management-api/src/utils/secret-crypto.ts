import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config";

const PREFIX = "enc:v1:";

function keyMaterial(encryptionKey: string): Buffer {
  if (encryptionKey.length < 32) {
    throw new Error("Secret encryption keys must contain at least 32 characters");
  }
  return createHash("sha256").update(encryptionKey).digest();
}

export function secretEncryptionKeyFingerprint(encryptionKey: string): string {
  keyMaterial(encryptionKey);
  return createHash("sha256")
    .update("supacloud:enc:v1:\0", "utf8")
    .update(encryptionKey, "utf8")
    .digest("hex");
}

function currentEncryptionKey(): string {
  if (config.secretsEncryptionKey === config.masterToken) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be independent from MASTER_TOKEN");
  }
  return config.secretsEncryptionKey;
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecretWithKey(value: string, encryptionKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

export function decryptSecretWithKey(value: string, encryptionKey: string): string {
  if (!isEncryptedSecret(value)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (raw.length < 28) throw new Error("Invalid encrypted secret payload");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial(encryptionKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptSecret(value: string): string {
  return encryptSecretWithKey(value, currentEncryptionKey());
}

export function decryptSecret(value: string): string {
  return decryptSecretWithKey(value, currentEncryptionKey());
}

export function encryptSecretIfNeeded(value: string): string {
  return isEncryptedSecret(value) ? value : encryptSecret(value);
}

export function decryptSecretIfNeeded(value: string): string {
  return decryptSecret(value);
}
