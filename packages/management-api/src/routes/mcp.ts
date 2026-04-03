/**
 * MCP Route — Streamable HTTP transport for MCP protocol.
 *
 * Endpoints:
 *   POST /mcp   — MCP JSON-RPC (tool calls, initialize, etc.)
 *   GET  /mcp   — SSE stream for server-initiated messages
 *   DELETE /mcp — Close session
 *
 * Auth: Bearer token in Authorization header.
 *   - masterToken → admin (all tools)
 *   - HMAC-signed token → project-scoped (subset of tools)
 *
 * Uses Elysia's onRequest lifecycle to intercept /mcp paths BEFORE
 * body parsing, passing the raw Request directly to MCP SDK's
 * WebStandardStreamableHTTPServerTransport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyMcpToken, type McpTokenPayload } from "../mcp/token";
import { registerMcpTools } from "../mcp/tools";
import { sql as metaSql } from "../db";

// Session store: sessionId → { transport, server, _createdAt }
const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: McpServer; _createdAt: number }>();

// Cleanup old sessions every 30 minutes
setInterval(() => {
  const maxAge = 30 * 60_000;
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session._createdAt > maxAge) {
      session.transport.close?.();
      sessions.delete(id);
    }
  }
}, 30 * 60_000);

/**
 * Authenticate MCP request. Priority order:
 * 1. Master token → admin role
 * 2. HMAC-signed MCP token → project/admin role
 * 3. Project service_role_key → project role with full access
 */
async function authenticate(headers: Headers): Promise<McpTokenPayload | null> {
  const authHeader = headers.get("authorization") || headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  // 1. Try MCP token (includes master token check)
  const mcpPayload = await verifyMcpToken(token);
  if (mcpPayload) return mcpPayload;

  // 2. Try service_role_key lookup
  try {
    const rows = await metaSql`
      SELECT ref FROM projects
      WHERE service_role_key = ${token}
        AND status = 'active'
      LIMIT 1
    `;
    if (rows.length > 0) {
      return {
        role: "project",
        ref: rows[0].ref as string,
        readonly: false,
        exp: Infinity,
        iat: Date.now(),
        name: "service_role_key",
      };
    }
  } catch {
    // DB lookup failed, fall through
  }

  return null;
}

function createMcpSession(tokenPayload: McpTokenPayload) {
  const serverName = tokenPayload.ref ? `supacloud-${tokenPayload.ref}` : "supacloud";
  const server = new McpServer({ name: serverName, version: "0.5.5" });

  registerMcpTools(server, tokenPayload);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      sessions.set(sessionId, { transport, server, _createdAt: Date.now() });
    },
  });

  server.connect(transport);

  return { transport, server, _createdAt: Date.now() };
}

// JSON helper
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Handle MCP request (POST, GET, DELETE)
export async function handleMcp(request: Request): Promise<Response> {
  const method = request.method;

  // Auth check (all methods)
  const tokenPayload = await authenticate(request.headers);
  if (!tokenPayload) {
    return jsonResponse({ error: "Invalid or missing MCP token" }, 401);
  }

  // POST /mcp — JSON-RPC
  if (method === "POST") {
    const url = new URL(request.url);
    // Token creation endpoint
    if (url.pathname === "/mcp/tokens") {
      if (tokenPayload.role !== "admin") {
        return jsonResponse({ error: "Admin token required" }, 403);
      }
      const body = await request.json() as Record<string, unknown>;
      const { createMcpToken } = await import("../mcp/token");
      if (!body.ref) {
        return jsonResponse({ error: "ref is required" }, 400);
      }
      const token = await createMcpToken({
        role: "project",
        ref: body.ref as string,
        name: (body.name as string) || "default",
        readonly: (body.readonly as boolean) ?? true,
        expiresInDays: (body.expires_days as number) ?? 365,
      });
      return jsonResponse({ token, ref: body.ref, readonly: (body.readonly as boolean) ?? true, expires_days: (body.expires_days as number) ?? 365 });
    }

    // MCP JSON-RPC
    const sessionId = request.headers.get("mcp-session-id");
    let session: { transport: WebStandardStreamableHTTPServerTransport; server: McpServer };

    if (sessionId && sessions.has(sessionId)) {
      session = sessions.get(sessionId)!;
    } else {
      session = createMcpSession(tokenPayload);
    }

    return await session.transport.handleRequest(request);
  }

  // GET /mcp — SSE stream
  if (method === "GET") {
    const sessionId = request.headers.get("mcp-session-id");
    if (!sessionId || !sessions.has(sessionId)) {
      return jsonResponse({ error: "No active session. Send POST /mcp first to initialize." }, 400);
    }
    const session = sessions.get(sessionId)!;
    return await session.transport.handleRequest(request);
  }

  // DELETE /mcp — Close session
  if (method === "DELETE") {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.transport.close?.();
      sessions.delete(sessionId);
    }
    return jsonResponse({ message: "Session closed" });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
