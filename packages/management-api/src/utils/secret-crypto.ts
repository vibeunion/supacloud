import { config } from "../config";
import { decryptSecretWithKey, encryptSecretWithKey, isEncryptedSecret } from "./secret-crypto-core";
export { decryptSecretWithKey, encryptSecretWithKey, isEncryptedSecret, secretEncryptionKeyFingerprint } from "./secret-crypto-core";

function currentEncryptionKey(): string {
  if (config.secretsEncryptionKey === config.masterToken) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be independent from MASTER_TOKEN");
  }
  return config.secretsEncryptionKey;
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
