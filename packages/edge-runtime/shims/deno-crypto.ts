// Deno std/crypto → Web Crypto API (Bun native)
import { randomUUID } from "crypto";

export const crypto = globalThis.crypto;

export function randomUUIDv4(): string {
  return randomUUID();
}

export async function digestMessage(
  algorithm: string,
  data: string,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return globalThis.crypto.subtle.digest(algorithm, encoder.encode(data));
}
