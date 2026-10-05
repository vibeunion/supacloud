import { Elysia } from "elysia";
import { verifyProjectJwt, type ProjectJwtContext } from "../middleware/auth";
import { sql } from "../db";
import { resolveTenantPorts } from "../utils/project-routing";
import { projectService } from "../services";
import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";
import { buildProjectJwtSettings } from "../services/project-jwt-settings";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMN_PATTERN = /^(?:\*|[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)$/;
const RESPONSE_HEADERS = {
  "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  "Cache-Control": "no-store",
};

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};
type AppPrincipal = { ref: string; userId: string; token: string };
type AppMcpDependencies = {
  verify: (token: string, ref: string) => Promise<ProjectJwtContext | null>;
  port: (ref: string) => Promise<number>;
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
  authorizationServer?: (ref: string) => Promise<string | null>;
  publicOrigin?: string;
  resourceOrigin?: (ref: string) => Promise<string | null>;
};

class InputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseJson(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...RESPONSE_HEADERS, ...headers } });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return responseJson({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

async function readBoundedJson(response: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new InputError("JSON response body is missing");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new InputError("JSON response exceeds size limit");
      }
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length > 63 || !IDENTIFIER_PATTERN.test(value)) {
    throw new InputError("Invalid identifier");
  }
  return value;
}

function buildToolPath(name: string, args: Record<string, unknown>): string {
  if (name === "app.read_table") {
    const allowed = new Set(["table", "select", "filters", "limit", "offset"]);
    if (Object.keys(args).some((key) => !allowed.has(key))) throw new InputError("Unknown argument");
    const table = requiredIdentifier(args.table);
    const select = args.select ?? "*";
    if (typeof select !== "string" || select.length > 2048 || !COLUMN_PATTERN.test(select)) {
      throw new InputError("Invalid select");
    }
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new InputError("Invalid limit");
    }
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new InputError("Invalid offset");
    }
    const query = new URLSearchParams({ select, limit: String(limit), offset: String(offset) });
    if (args.filters !== undefined) {
      if (!isRecord(args.filters) || Object.keys(args.filters).length > 20) throw new InputError("Invalid filters");
      for (const [column, rawValue] of Object.entries(args.filters)) {
        requiredIdentifier(column);
        if (["select", "limit", "offset", "order", "or", "and"].includes(column)) {
          throw new InputError("Reserved filter name");
        }
        if (typeof rawValue !== "string" || !/^(eq|neq|gt|gte|lt|lte|in)\.[^\r\n\0]{1,1000}$/.test(rawValue)) {
          throw new InputError("Invalid filter");
        }
        query.append(column, rawValue);
      }
    }
    return `/${table}?${query.toString()}`;
  }

  if (name === "app.call_readonly_rpc") {
    const allowed = new Set(["function", "args"]);
    if (Object.keys(args).some((key) => !allowed.has(key))) throw new InputError("Unknown argument");
    const functionName = requiredIdentifier(args.function);
    const values = args.args ?? {};
    if (!isRecord(values) || Object.keys(values).length > 30) throw new InputError("Invalid RPC arguments");
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      requiredIdentifier(key);
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      if (encoded === undefined || encoded.length > 2000) throw new InputError("RPC argument is too large");
      query.set(key, encoded);
    }
    return `/rpc/${functionName}?${query.toString()}`;
  }

  throw new InputError("Unknown app MCP tool");
}

const APP_TOOLS = [
  {
    name: "app.read_table",
    description: "Read up to 100 rows with the authenticated user's Data API permissions.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      required: ["table"],
      additionalProperties: false,
      properties: {
        table: { type: "string" },
        select: { type: "string" },
        filters: { type: "object", additionalProperties: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
      },
    },
  },
  {
    name: "app.call_readonly_rpc",
    description: "Call a read-only RPC using the authenticated user's grants.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      required: ["function"],
      additionalProperties: false,
      properties: { function: { type: "string" }, args: { type: "object" } },
    },
  },
] as const;

export function isAppMcpRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (request.method === "POST" && /^\/mcp\/app\/projects\/[A-Za-z0-9_-]{1,64}$/.test(pathname))
    || (request.method === "GET" && /^\/\.well-known\/oauth-protected-resource\/mcp\/app\/projects\/[A-Za-z0-9_-]{1,64}$/.test(pathname));
}

export function createAppMcpHandler(dependencies: AppMcpDependencies) {
  const configuredOrigin = dependencies.publicOrigin ? new URL(dependencies.publicOrigin).origin : undefined;
  if (dependencies.publicOrigin && (configuredOrigin !== dependencies.publicOrigin
    || (!dependencies.publicOrigin.startsWith("https://") && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(dependencies.publicOrigin)))) {
    throw new Error("App MCP public origin must be an HTTPS origin or a loopback development origin");
  }
  return async (request: Request, ref: string): Promise<Response> => {
    if (!PROJECT_REF_PATTERN.test(ref)) return responseJson({ error: "Invalid project ref" }, 400);
    let originUrl: string;
    try {
      originUrl = configuredOrigin ?? await dependencies.resourceOrigin?.(ref) ?? new URL(request.url).origin;
      const parsed = new URL(originUrl);
      if (parsed.origin !== originUrl || (!["https:"].includes(parsed.protocol)
        && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)))) {
        throw new Error("Invalid resource origin");
      }
    } catch { return responseJson({ error: "Project resource metadata unavailable" }, 503); }
    if (request.method === "GET") {
      try {
        const authorizationServer = await dependencies.authorizationServer?.(ref);
        if (!authorizationServer) return responseJson({ error: "Project OAuth server is not configured" }, 503);
        return responseJson({
          resource: `${originUrl}/mcp/app/projects/${ref}`,
          authorization_servers: [authorizationServer],
          bearer_methods_supported: ["header"],
        });
      } catch { return responseJson({ error: "Project OAuth metadata unavailable" }, 503); }
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== originUrl) return responseJson({ error: "Origin not allowed" }, 403);

    const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token || token.length > 16_384) {
      const metadata = `${originUrl}/.well-known/oauth-protected-resource/mcp/app/projects/${ref}`;
      return responseJson({ error: "Bearer user JWT required" }, 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${metadata}"`,
      });
    }
    let jwt: ProjectJwtContext | null;
    try { jwt = await dependencies.verify(token, ref); }
    catch { return responseJson({ error: "User verification unavailable" }, 503); }
    if (!jwt || jwt.ref !== ref || jwt.role !== "authenticated" || !jwt.sub?.trim()) {
      return responseJson({ error: "Authenticated project user required" }, 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${originUrl}/.well-known/oauth-protected-resource/mcp/app/projects/${ref}"`,
      });
    }
    const principal: AppPrincipal = { ref, userId: jwt.sub, token };

    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return responseJson({ error: "application/json required" }, 415);
    }
    const protocol = request.headers.get("mcp-protocol-version");
    if (protocol && protocol !== MCP_PROTOCOL_VERSION) {
      return responseJson({ error: "Unsupported MCP protocol version" }, 400);
    }

    let message: JsonRpcMessage;
    try {
      const parsed = await readBoundedJson(request, 65_536);
      if (!isRecord(parsed)) throw new InputError("Invalid Request");
      message = parsed;
    } catch {
      return rpcError(null, -32700, "Invalid or oversized JSON", 400);
    }

    const id = message.id;
    const validId = id === undefined || id === null || typeof id === "string" || typeof id === "number";
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || !validId
      || (message.params !== undefined && !isRecord(message.params))) {
      return rpcError(null, -32600, "Invalid Request", 400);
    }
    if (id === undefined) {
      if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
        return new Response(null, { status: 202, headers: RESPONSE_HEADERS });
      }
      return rpcError(null, -32600, "Request id required", 400);
    }

    const rpcId = (id ?? null) as JsonRpcId;
    const result = (value: unknown) => responseJson({ jsonrpc: "2.0", id: rpcId, result: value });
    if (message.method === "initialize") {
      return result({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "supacloud-app", version: "0.1.0" },
        instructions: "Reads use the authenticated user's project JWT and RLS.",
      });
    }
    if (message.method === "ping") return result({});
    if (message.method === "tools/list") return result({ tools: APP_TOOLS });
    if (message.method !== "tools/call") return rpcError(rpcId, -32601, "Method not found");

    try {
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (typeof params.name !== "string" || !isRecord(params.arguments ?? {})) {
        throw new InputError("Invalid tool arguments");
      }
      const path = buildToolPath(params.name, (params.arguments ?? {}) as Record<string, unknown>);
      const port = await dependencies.port(ref);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Unavailable project port");
      const upstream = await dependencies.fetcher(`http://127.0.0.1:${port}${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${principal.token}`, accept: "application/json" },
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return result({ isError: true, content: [{ type: "text", text: `Data API rejected request (${upstream.status})` }] });
      }
      const data = await readBoundedJson(upstream, 1_048_576);
      return result({
        content: [{ type: "text", text: JSON.stringify({ project_ref: ref, user_id: principal.userId, data }) }],
      });
    } catch (error) {
      if (error instanceof InputError) return rpcError(rpcId, -32602, error.message);
      return result({ isError: true, content: [{ type: "text", text: "Project Data API unavailable" }] });
    }
  };
}

const handler = createAppMcpHandler({
  verify: verifyProjectJwt,
  fetcher: fetch,
  publicOrigin: process.env.SUPACLOUD_APP_MCP_ORIGIN,
  resourceOrigin: async ref => (await projectService.getProject(ref))?.api.url ?? null,
  port: async (ref) => {
    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      SELECT config FROM projects WHERE ref = ${ref} AND deleted_at IS NULL AND lower(status) = 'active' LIMIT 1
    `;
    const port = row && resolveTenantPorts(row.config)?.pgrstPort;
    if (!port) throw new Error("Project Data API unavailable");
    return port;
  },
  authorizationServer: async ref => {
    const project = await projectService.getProject(ref);
    if (!project) return null;
    const runtime = getAuthRuntimeDescriptor(ref);
    const authorityRef = runtime.authority_project_ref;
    const authority = authorityRef === ref ? project : await projectService.getProject(authorityRef);
    if (!authority) return null;
    const settings = await buildProjectJwtSettings(authorityRef, authority.config, getAuthRuntimeDescriptor(authorityRef));
    return settings.signing?.oauth_enabled ? settings.signing.issuer : null;
  },
});

export function createAppMcpRoutes(appHandler: ReturnType<typeof createAppMcpHandler> = handler) {
  return new Elysia()
    .get("/.well-known/oauth-protected-resource/mcp/app/projects/:ref",
      ({ request, params }) => appHandler(request, params.ref))
    .post("/mcp/app/projects/:ref", { parse: "none" },
      ({ request, params }) => appHandler(request, params.ref));
}

export const appMcpRoutes = createAppMcpRoutes();
