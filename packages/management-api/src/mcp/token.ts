/**
 * MCP Token — HMAC-SHA256 JWT-like tokens for MCP access control.
 *
 * Token payload: { role: "admin" | "project", ref?: string, readonly?: boolean, exp: number }
 * Format: base64url(payload).hex(HMAC-SHA256(payload, masterToken))
 */
import { config } from "../config";
import { logger } from "../utils/logger";

export type McpTokenRole = "admin" | "project";

export interface McpTokenPayload {
  role: McpTokenRole;
  ref?: string;        // project ref (only for role=project)
  readonly?: boolean;  // read-only mode
  exp: number;         // expiry timestamp (ms)
  iat: number;         // issued at (ms)
  name?: string;       // human-readable label
}

function base64url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): string {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

async function hmacSign(payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(config.masterToken),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create an MCP token.
 */
export async function createMcpToken(opts: {
  role: McpTokenRole;
  ref?: string;
  readonly?: boolean;
  name?: string;
  expiresInDays?: number;
}): Promise<string> {
  const payload: McpTokenPayload = {
    role: opts.role,
    ref: opts.ref,
    readonly: opts.readonly,
    name: opts.name,
    iat: Date.now(),
    exp: Date.now() + (opts.expiresInDays ?? 365) * 86400_000,
  };
  const payloadStr = JSON.stringify(payload);
  const encoded = base64url(payloadStr);
  const sig = await hmacSign(encoded);
  return `${encoded}.${sig}`;
}

/**
 * Verify and decode an MCP token. Returns null if invalid/expired.
 * Also accepts the raw masterToken directly (backwards compat).
 */
export async function verifyMcpToken(token: string): Promise<McpTokenPayload | null> {
  // Direct master token → admin role, no expiry
  if (token === config.masterToken) {
    return { role: "admin", exp: Infinity, iat: 0 };
  }

  const dotIdx = token.indexOf(".");
  if (dotIdx < 0) return null;

  const encoded = token.substring(0, dotIdx);
  const sig = token.substring(dotIdx + 1);

  // Verify signature
  const expected = await hmacSign(encoded);
  if (sig !== expected) return null;

  // Decode payload
  try {
    const payload: McpTokenPayload = JSON.parse(base64urlDecode(encoded));
    if (payload.exp < Date.now()) return null; // expired
    return payload;
  } catch (err: unknown) {
    logger.warn("[] parse failed silently", { error: err });
    return null;
  }
}
