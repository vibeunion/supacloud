import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIXES = {
  publishable: "sb_publishable_",
  secret: "sb_secret_",
} as const;

export type OpaqueApiKeyKind = keyof typeof API_KEY_PREFIXES;

function randomKeyMaterial(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function generatePublishableApiKey(): string {
  return `${API_KEY_PREFIXES.publishable}${randomKeyMaterial(24)}`;
}

export function generateSecretApiKey(): string {
  return `${API_KEY_PREFIXES.secret}${randomKeyMaterial(32)}`;
}

export function hashSecretApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function isOpaqueApiKey(key: string): boolean {
  return key.startsWith(API_KEY_PREFIXES.publishable) || key.startsWith(API_KEY_PREFIXES.secret);
}
