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

  return { status: 403, body: { error: "Invalid token" } };
}
