// Deno std/encoding → Bun native Buffer API
// Reference: https://deno.land/std/encoding/base64.ts

// encode: arbitrary data → base64 string (official Deno std API)
export function encode(data: string | ArrayBuffer | Uint8Array): string {
  if (typeof data === "string") {
    return Buffer.from(data).toString("base64");
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Buffer.from(bytes).toString("base64");
}

// decode: base64 string → Uint8Array bytes (official Deno std API)
export function decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// Base64 URL-safe variants (no padding, uses - and _ instead of + and /)
export function encodeBase64(data: string | ArrayBuffer | Uint8Array): string {
  return encode(data);
}

export function decodeBase64(b64: string): Uint8Array {
  return decode(b64);
}

export function encodeBase64Url(
  data: string | ArrayBuffer | Uint8Array,
): string {
  return encode(data)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeBase64Url(b64url: string): Uint8Array {
  // Add padding back and convert URL-safe chars
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return decode(padded + "=".repeat(padLength));
}

// Hex encoding
export function encodeHex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

export function decodeHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
