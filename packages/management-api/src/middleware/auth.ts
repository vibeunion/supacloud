import { config } from "../config";
import { sql as metaSql } from "../db";
import { verifyMcpToken } from "../mcp/token";

/**
 * Validate the Authorization header. Returns error response body if invalid,
 * or undefined if the request is authorized.
 */
export async function checkAuth(request: Request): Promise<{ status: number; body: { error: string } } | undefined> {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return { status: 401, body: { error: "Missing Authorization header" } };
  }

  if (!authorization.startsWith("Bearer ")) {
    return { status: 401, body: { error: "Invalid Authorization format" } };
  }

  const token = authorization.slice(7);

  if (token === config.masterToken) {
    return undefined;
  }

  // Verify if it's a valid Studio Session HMAC Token
  try {
    const parts = token.split(".");
    if (parts.length === 2) {
      const [payloadB64, sigHex] = parts;
      const payload = JSON.parse(atob(payloadB64));
      if (payload.exp > Date.now()) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(config.masterToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(payload)));
        const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
        const sigBuf = Buffer.from(sigHex, 'hex');
        const expBuf = Buffer.from(expected, 'hex');
        if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
           return undefined; // Authorized as studio user (admin)
        }
      }
    }
  } catch { } // Fall through to other token checks

  // Verify if it's a valid MCP token
  const mcpPayload = await verifyMcpToken(token);
  let role = mcpPayload?.role;
  let ref = mcpPayload?.ref;

  // If not MCP token, maybe it's service_role_key
  if (!mcpPayload && token.includes(".")) {
    try {
      const rows = await metaSql`
        SELECT ref FROM projects
        WHERE service_role_key = ${token}
          AND status = 'active'
        LIMIT 1
      `;
      if (rows.length > 0) {
        role = "project";
        ref = rows[0].ref as string;
      }
    } catch { } // Ignore DB errors, fall through
  }

  if (role === "admin") {
    return undefined;
  }

  // If tenant-scoped, strictly enforce URL path scoping
  if (role === "project" && ref) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`/v1/projects/${ref}`)) {
      return { status: 403, body: { error: `Token scoped strictly to project ${ref}, cannot access ${url.pathname}` } };
    }
    return undefined;
  }

  return { status: 401, body: { error: "Invalid token" } };
}
