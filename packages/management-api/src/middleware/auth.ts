import { config } from "../config";
import { sql as metaSql } from "../db";
import { verifyMcpToken } from "../mcp/token";
import { timingSafeEqual } from "crypto";
import {
  extractProjectRefCandidates,
  extractProjectRefFromPath,
} from "../utils/project-auth";

export interface ProjectJwtContext {
  role: string;
  ref: string;
  sub?: string;
}

export async function verifyProjectJwt(
  token: string,
  scopedRef?: string | null,
): Promise<ProjectJwtContext | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "HS256") return null;

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.role !== "string" || !payload.role) return null;

    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
      return null;
    }

    const candidateRefs = extractProjectRefCandidates(payload, scopedRef);
    if (candidateRefs.length === 0) return null;

    const encoder = new TextEncoder();
    const sigBuf = Buffer.from(parts[2], "base64url");
    const data = encoder.encode(`${parts[0]}.${parts[1]}`);

    for (const ref of candidateRefs) {
      const [project] = await metaSql`
        SELECT ref, jwt_secret FROM projects
        WHERE ref = ${ref} AND lower(status) = 'active'
        LIMIT 1
      `;
      if (!project?.jwt_secret) continue;

      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(project.jwt_secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const valid = await crypto.subtle.verify("HMAC", key, sigBuf, data);
      if (valid) {
        return {
          role: payload.role,
          ref,
          sub: typeof payload.sub === "string" ? payload.sub : undefined,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

export type AuthContext =
  | { role: "master" }
  | { role: "admin" }
  | { role: "project"; ref: string };

export async function getAuthContext(request: Request): Promise<AuthContext | { status: number; body: { error: string } }> {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return { status: 401, body: { error: "Missing Authorization header" } };
  }

  if (!authorization.startsWith("Bearer ")) {
    return { status: 401, body: { error: "Invalid Authorization format" } };
  }

  const token = authorization.slice(7).trim();
  const url = new URL(request.url);
  const scopedRef = extractProjectRefFromPath(url.pathname);

  if (!token) {
    return { status: 401, body: { error: "Invalid token" } };
  }

  if (config.masterToken) {
    const tokenBuf = Buffer.from(token, "utf8");
    const masterBuf = Buffer.from(config.masterToken, "utf8");
    if (tokenBuf.length === masterBuf.length && timingSafeEqual(tokenBuf, masterBuf)) {
      return { role: "master" };
    }
  }

  try {
    const parts = token.split(".");
    if (parts.length === 2) {
      const [payloadB64, sigHex] = parts;
      const payload = JSON.parse(atob(payloadB64));
      const expMs = typeof payload.exp === "number" && payload.exp < 10_000_000_000
        ? payload.exp * 1000
        : payload.exp;
      if (config.masterToken && typeof expMs === "number" && expMs > Date.now()) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(config.masterToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(payload)));
        const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
        const sigBuf = Buffer.from(sigHex, 'hex');
        const expBuf = Buffer.from(expected, 'hex');
        if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
           return { role: "admin" };
        }
      }
    }
  } catch { }

  const mcpPayload = await verifyMcpToken(token);
  let role = mcpPayload?.role;
  let ref = mcpPayload?.ref;

  if (!mcpPayload && token.includes(".")) {
    const [project] = scopedRef
      ? await metaSql`
          SELECT ref FROM projects
          WHERE ref = ${scopedRef}
            AND service_role_key = ${token}
            AND lower(status) = 'active'
          LIMIT 1
        `
      : await metaSql`
          SELECT ref FROM projects
          WHERE service_role_key = ${token}
            AND lower(status) = 'active'
          LIMIT 1
        `;
    if (project) {
      role = "project";
      ref = project.ref as string;
    }

    if (!role) {
      const jwtResult = await verifyProjectJwt(token, scopedRef);
      if (jwtResult?.role === "service_role") {
        role = "project";
        ref = jwtResult.ref;
      }
    }
  }

  if (role === "admin") {
    return { role: "admin" };
  }

  if (role === "project" && ref) {
    const pathRef = extractProjectRefFromPath(url.pathname);
    if (pathRef !== ref) {
      return { status: 403, body: { error: `Token scoped strictly to project ${ref}, cannot access ${url.pathname}` } };
    }
    return { role: "project", ref };
  }

  return { status: 401, body: { error: "Invalid token" } };
}

export async function checkAuth(request: Request): Promise<{ status: number; body: { error: string } } | undefined> {
  const auth = await getAuthContext(request);
  return "status" in auth ? auth : undefined;
}

export async function requireAdminAuth(request: Request): Promise<{ status: number; body: { error: string } } | undefined> {
  const auth = await getAuthContext(request);
  if ("status" in auth) return auth;
  if (auth.role === "master" || auth.role === "admin") return undefined;
  return { status: 403, body: { error: "Admin privileges required" } };
}

export async function requireProjectOrAdminAuth(request: Request, ref: string): Promise<{ status: number; body: { error: string } } | undefined> {
  const auth = await getAuthContext(request);
  if ("status" in auth) return auth;
  if (auth.role === "master" || auth.role === "admin") return undefined;
  if (auth.role === "project" && auth.ref === ref) return undefined;
  return { status: 403, body: { error: "Project service role or admin privileges required" } };
}
