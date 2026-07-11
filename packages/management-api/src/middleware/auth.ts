import { config } from "../config";
import { sql as metaSql } from "../db";
import { verifyMcpToken } from "../mcp/token";
import { timingSafeEqual } from "crypto";
import {
  extractProjectRefCandidates,
  extractProjectRefFromPath,
} from "../utils/project-auth";
import { verifyProjectJwtPayload } from "../utils/project-jwt";
import {
  studioSessionService,
  type StudioSessionService,
} from "../services/studio-session.service";

export const STUDIO_SESSION_COOKIE = "__Host-supacloud_session";

export function readStudioSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") || "";
  for (const pair of cookie.split(";")) {
    const [rawName, ...rawValue] = pair.trim().split("=");
    if (rawName !== STUDIO_SESSION_COOKIE) continue;
    const value = rawValue.join("=");
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function isSameOriginStudioRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const requestUrl = new URL(request.url);
    // Host is browser-controlled only through the target URL. Do not trust
    // X-Forwarded-Host here: a direct client can forge it and bypass CSRF checks.
    const expectedHost = request.headers.get("host")
      || requestUrl.host;
    const expectedProtocol = (request.headers.get("x-forwarded-proto") || requestUrl.protocol)
      .replace(/:$/, "")
      .toLowerCase();
    const originUrl = new URL(origin);
    return originUrl.host.toLowerCase() === expectedHost.toLowerCase()
      && originUrl.protocol.replace(/:$/, "").toLowerCase() === expectedProtocol;
  } catch {
    return false;
  }
}

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

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof header.alg !== "string") return null;

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.role !== "string" || !payload.role) return null;

    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
      return null;
    }

    const candidateRefs = extractProjectRefCandidates(payload, scopedRef);
    if (candidateRefs.length === 0) return null;

    for (const ref of candidateRefs) {
      const verification = await verifyProjectJwtPayload(ref, token);
      if (verification) {
        return {
          role: String(verification.payload.role),
          ref,
          sub: typeof verification.payload.sub === "string" ? verification.payload.sub : undefined,
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
  | { role: "admin"; source: "bearer" | "cookie" }
  | { role: "project"; ref: string };

type AuthResolverDependencies = {
  studioSessions?: Pick<StudioSessionService, "verify">;
};

export function createAuthResolver(dependencies: AuthResolverDependencies = {}) {
  const studioSessions = dependencies.studioSessions ?? studioSessionService;

  return async function resolveAuthContext(
    request: Request,
  ): Promise<AuthContext | { status: number; body: { error: string } }> {
    const authorization = request.headers.get("authorization");

    if (!authorization) {
      const sessionToken = readStudioSessionToken(request);
      const session = sessionToken ? await studioSessions.verify(sessionToken) : null;
      if (!session) {
        return { status: 401, body: { error: "Missing Authorization header" } };
      }
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())
        && !isSameOriginStudioRequest(request)
      ) {
        return { status: 403, body: { error: "Cross-origin session request denied" } };
      }
      return { role: "admin", source: "cookie" };
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

  const mcpPayload = await verifyMcpToken(token);
  let role = mcpPayload?.role;
  let ref = mcpPayload?.ref;

  if (!mcpPayload && token.split(".").length === 3) {
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
    return { role: "admin", source: "bearer" };
  }

  if (role === "project" && ref) {
    const pathRef = extractProjectRefFromPath(url.pathname);
    if (pathRef !== ref) {
      return { status: 403, body: { error: `Token scoped strictly to project ${ref}, cannot access ${url.pathname}` } };
    }
    return { role: "project", ref };
  }

    return { status: 401, body: { error: "Invalid token" } };
  };
}

export const getAuthContext = createAuthResolver();

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
