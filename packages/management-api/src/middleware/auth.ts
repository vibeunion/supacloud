import { config } from "../config";
import { sql as metaSql } from "../db";
import { verifyMcpToken } from "../mcp/token";
import { logger } from "../utils/logger";

export interface AuthContext {
  role: "admin" | "project";
  ref?: string;
  tokenType: "master" | "session" | "mcp" | "project_jwt" | "service_role_key";
}

const PUBLIC_PATH_PREFIXES = [
  "/v1/system/info",
  "/v1/system/health",
  "/health",
  "/auth/verify",
];

const jwtCache = new Map<string, { result: AuthContext | null; expiresAt: number }>();
const JWT_CACHE_TTL = 60_000;

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").substring(0, 32);
}

async function verifyProjectJwt(token: string): Promise<{ role: string; ref: string } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = JSON.parse(atob(parts[0]));
    if (header.alg !== "HS256") return null;

    const payload = JSON.parse(atob(parts[1]));
    if (!payload.sub || !payload.iss) return null;

    const issMatch = payload.iss.match(/supabase\.co|supacloud/);
    if (!issMatch && !payload.role) return null;

    const refFromIss = payload.iss.split(".")[0]?.replace("https://", "") || payload.ref;
    if (!refFromIss) return null;

    const [project] = await metaSql`
      SELECT ref, jwt_secret FROM projects
      WHERE ref = ${refFromIss} AND status = 'active'
      LIMIT 1
    `;
    if (!project?.jwt_secret) return null;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(project.jwt_secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBuf = Buffer.from(parts[2], "base64url");
    const data = encoder.encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify("HMAC", key, sigBuf, data);
    if (!valid) return null;

    if (payload.exp && payload.exp < Date.now() / 1000) return null;

    return { role: payload.role || "authenticated", ref: refFromIss };
  } catch {
    return null;
  }
}

function verifySessionToken(token: string): Promise<boolean> {
  return (async () => {
    try {
      const parts = token.split(".");
      if (parts.length !== 2) return false;

      const [payloadB64, sigHex] = parts;
      const payloadRaw = atob(payloadB64);
      const payload = JSON.parse(payloadRaw);

      if (!payload.exp || payload.exp <= Date.now()) return false;

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(config.masterToken),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadRaw));
      const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

      const sigBuf = Buffer.from(sigHex, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  })();
}

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
    (request as any).__authContext = { role: "admin", tokenType: "master" } as AuthContext;
    return undefined;
  }

  if (token.includes(".") && token.split(".").length === 2) {
    if (await verifySessionToken(token)) {
      (request as any).__authContext = { role: "admin", tokenType: "session" } as AuthContext;
      return undefined;
    }
  }

  const mcpPayload = await verifyMcpToken(token);
  let role = mcpPayload?.role;
  let ref = mcpPayload?.ref;
  let tokenType: AuthContext["tokenType"] = "mcp";

  if (!mcpPayload && token.includes(".")) {
    const srkHash = await hashToken(token);
    const cacheKey = `srk:${srkHash}`;
    const cached = jwtCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.result) {
        (request as any).__authContext = cached.result;
        return undefined;
      }
    } else {
      const [project] = await metaSql`
        SELECT ref FROM projects
        WHERE service_role_key = ${token}
          AND status = 'active'
        LIMIT 1
      `;
      if (project) {
        const ctx: AuthContext = { role: "project", ref: project.ref as string, tokenType: "service_role_key" };
        jwtCache.set(cacheKey, { result: ctx, expiresAt: Date.now() + JWT_CACHE_TTL });
        role = "project";
        ref = project.ref as string;
        tokenType = "service_role_key";
      }
    }

    if (!role) {
      const jwtHash = await hashToken(token);
      const jwtCacheKey = `jwt:${jwtHash}`;
      const jwtCached = jwtCache.get(jwtCacheKey);
      if (jwtCached && jwtCached.expiresAt > Date.now()) {
        if (jwtCached.result) {
          (request as any).__authContext = jwtCached.result;
          return undefined;
        }
      } else {
        const jwtResult = await verifyProjectJwt(token);
        if (jwtResult) {
          role = jwtResult.role === "service_role" ? "project" : "project";
          ref = jwtResult.ref;
          tokenType = "project_jwt";
          const ctx: AuthContext = { role, ref, tokenType };
          jwtCache.set(jwtCacheKey, { result: ctx, expiresAt: Date.now() + JWT_CACHE_TTL });
        } else {
          jwtCache.set(jwtCacheKey, { result: null, expiresAt: Date.now() + 30_000 });
        }
      }
    }
  }

  if (role === "admin") {
    (request as any).__authContext = { role: "admin", ref, tokenType } as AuthContext;
    return undefined;
  }

  if (role === "project" && ref) {
    const url = new URL(request.url);
    const isPublicPath = PUBLIC_PATH_PREFIXES.some(prefix => url.pathname.startsWith(prefix));
    if (!url.pathname.startsWith(`/v1/projects/${ref}`) && !isPublicPath) {
      return { status: 403, body: { error: `Token scoped strictly to project ${ref}, cannot access ${url.pathname}` } };
    }
    (request as any).__authContext = { role, ref, tokenType } as AuthContext;
    return undefined;
  }

  return { status: 401, body: { error: "Invalid token" } };
}

export function getAuthContext(request: Request): AuthContext | null {
  return (request as any).__authContext as AuthContext | null;
}
