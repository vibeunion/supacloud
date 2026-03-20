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
 */
import { Elysia } from "elysia";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyMcpToken, type McpTokenPayload } from "../mcp/token";
import { registerMcpTools } from "../mcp/tools";

// Session store: sessionId → { transport, server }
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

// Cleanup old sessions every 30 minutes
setInterval(() => {
  const maxAge = 30 * 60_000;
  const now = Date.now();
  for (const [id, session] of sessions) {
    if ((session as any)._createdAt && now - (session as any)._createdAt > maxAge) {
      session.transport.close?.();
      sessions.delete(id);
    }
  }
}, 30 * 60_000);

async function authenticate(headers: Record<string, string | undefined>): Promise<McpTokenPayload | null> {
  const authHeader = headers.authorization || headers.Authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return await verifyMcpToken(token);
}

function createMcpSession(tokenPayload: McpTokenPayload): { transport: StreamableHTTPServerTransport; server: McpServer } {
  const serverName = tokenPayload.ref ? `supacloud-${tokenPayload.ref}` : "supacloud";
  const server = new McpServer({ name: serverName, version: "0.5.5" });

  registerMcpTools(server, tokenPayload);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      const session = { transport, server, _createdAt: Date.now() } as any;
      sessions.set(sessionId, session);
    },
  });

  server.connect(transport);

  return { transport, server };
}

export const mcpRoutes = new Elysia({ prefix: "/mcp" })
  // POST /mcp — Main JSON-RPC endpoint
  .post("/", async ({ request, headers, set }) => {
    const tokenPayload = await authenticate(headers as any);
    if (!tokenPayload) {
      set.status = 401;
      return { error: "Invalid or missing MCP token" };
    }

    // Check for existing session
    const sessionId = headers["mcp-session-id"] as string | undefined;
    let session: { transport: StreamableHTTPServerTransport; server: McpServer };

    if (sessionId && sessions.has(sessionId)) {
      session = sessions.get(sessionId)!;
    } else {
      // New session (initialize request)
      session = createMcpSession(tokenPayload);
    }

    // Convert Elysia request to a standard request and pipe through transport
    try {
      const body = await request.json();
      const fakeReq = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      });

      // Use a promise to collect the response
      const response = await session.transport.handleRequest(fakeReq);
      
      if (response) {
        // Copy headers from MCP response
        for (const [k, v] of response.headers.entries()) {
          set.headers[k] = v;
        }
        set.status = response.status;
        return response.body ? await response.text() : "";
      }

      set.status = 202;
      return "";
    } catch (e: any) {
      console.error("[MCP] Error:", e);
      set.status = 500;
      return { error: e.message };
    }
  })

  // GET /mcp — SSE stream (for server-initiated notifications)
  .get("/", async ({ request, headers, set }) => {
    const tokenPayload = await authenticate(headers as any);
    if (!tokenPayload) {
      set.status = 401;
      return { error: "Invalid or missing MCP token" };
    }

    const sessionId = headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      set.status = 400;
      return { error: "No active session. Send POST /mcp first to initialize." };
    }

    const session = sessions.get(sessionId)!;
    try {
      const response = await session.transport.handleRequest(request);
      if (response) {
        for (const [k, v] of response.headers.entries()) {
          set.headers[k] = v;
        }
        set.status = response.status;
        return response.body;
      }
      set.status = 200;
      return "";
    } catch (e: any) {
      set.status = 500;
      return { error: e.message };
    }
  })

  // DELETE /mcp — Close session
  .delete("/", async ({ headers, set }) => {
    const sessionId = headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.transport.close?.();
      sessions.delete(sessionId);
    }
    set.status = 200;
    return { message: "Session closed" };
  })

  // Token management (admin only, no /mcp prefix needed really but grouping here)
  .post("/tokens", async ({ headers, body, set }) => {
    const tokenPayload = await authenticate(headers as any);
    if (!tokenPayload || tokenPayload.role !== "admin") {
      set.status = 403;
      return { error: "Admin token required" };
    }

    const { createMcpToken } = await import("../mcp/token");
    const { ref, name, readonly, expires_days } = body as any;
    if (!ref) {
      set.status = 400;
      return { error: "ref is required" };
    }

    const token = await createMcpToken({
      role: "project",
      ref,
      name: name || "default",
      readonly: readonly ?? true,
      expiresInDays: expires_days ?? 365,
    });

    return { token, ref, readonly: readonly ?? true, expires_days: expires_days ?? 365 };
  });
