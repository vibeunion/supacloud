import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config";

const PREFIX = "enc:v1:";

function keyMaterial(): Buffer {
  return createHash("sha256").update(config.secretsEncryptionKey).digest();
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

export function decryptSecret(value: string): string {
  if (!isEncryptedSecret(value)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (raw.length < 29) throw new Error("Invalid encrypted secret payload");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptSecretIfNeeded(value: string): string {
  return isEncryptedSecret(value) ? value : encryptSecret(value);
}

export function decryptSecretIfNeeded(value: string): string {
  return decryptSecret(value);
}
