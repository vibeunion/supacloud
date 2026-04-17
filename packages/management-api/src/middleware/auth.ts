import { config } from "../config";
import { sql as metaSql } from "../db";
import { verifyMcpToken } from "../mcp/token";
import { logger } from "../utils/logger";

export interface AuthContext {
  role: "admin" | "project";
  ref?: string;
  tokenType: "master" | "session" | "mcp" | "project_jwt" | "service_role_key";
}

const jwtCache = new Map<string, { result: AuthContext | null; expiresAt: number }>();
const JWT_CACHE_TTL = 60_000;

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
    return undefined;
  }

  if (token.includes(".") && token.split(".").length === 2) {
    if (await verifySessionToken(token)) {
      return undefined;
    }
  }

  const mcpPayload = await verifyMcpToken(token);
  let role = mcpPayload?.role;
  let ref = mcpPayload?.ref;
  let tokenType: AuthContext["tokenType"] = "mcp";

  if (!mcpPayload && token.includes(".")) {
    const cacheKey = `srk:${token.substring(0, 16)}`;
    const cached = jwtCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.result) return undefined;
    } else {
      const [project] = await metaSql`
        SELECT ref FROM projects
        WHERE service_role_key = ${token}
          AND status = 'active'
        LIMIT 1
      `;
      if (project) {
        jwtCache.set(cacheKey, { result: { role: "project", ref: project.ref as string, tokenType: "service_role_key" }, expiresAt: Date.now() + JWT_CACHE_TTL });
        role = "project";
        ref = project.ref as string;
        tokenType = "service_role_key";
      }
    }

    if (!role) {
      const jwtCacheKey = `jwt:${token.substring(0, 16)}`;
      const jwtCached = jwtCache.get(jwtCacheKey);
      if (jwtCached && jwtCached.expiresAt > Date.now()) {
        if (jwtCached.result) {
          role = jwtCached.result.role;
          ref = jwtCached.result.ref;
          tokenType = "project_jwt";
        }
      } else {
        const jwtResult = await verifyProjectJwt(token);
        if (jwtResult) {
          role = jwtResult.role === "service_role" ? "project" : "project";
          ref = jwtResult.ref;
          tokenType = "project_jwt";
          jwtCache.set(jwtCacheKey, { result: { role, ref, tokenType }, expiresAt: Date.now() + JWT_CACHE_TTL });
        } else {
          jwtCache.set(jwtCacheKey, { result: null, expiresAt: Date.now() + 30_000 });
        }
      }
    }
  }

  if (role === "admin") {
    return undefined;
  }

  if (role === "project" && ref) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`/v1/projects/${ref}`)) {
      return { status: 403, body: { error: `Token scoped strictly to project ${ref}, cannot access ${url.pathname}` } };
    }
    return undefined;
  }

  return { status: 401, body: { error: "Invalid token" } };
}

export function getAuthContext(request: Request): AuthContext | null {
  return (request as any).__authContext as AuthContext | null;
}
