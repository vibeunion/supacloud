// Deno std/encoding → Bun native Buffer API

export function encode(data: string): Uint8Array {
  return Buffer.from(data, "base64");
}

export function decode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

export function encodeBase64(data: string | Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

export function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

export function encodeHex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

export function decodeHex(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "hex"));
}
