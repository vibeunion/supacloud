import { config } from "../config";
import { sql as metaSql } from "../db";
import { verifyMcpToken } from "../mcp/token";
import { timingSafeEqual } from "crypto";
import {
  extractProjectRefCandidates,
  extractProjectRefFromPath,
  resolveProjectApiKey,
} from "../utils/project-auth";
import { isOpaqueApiKey } from "../utils/api-keys";
import { verifyProjectJwtPayload } from "../utils/project-jwt";
import {
  studioSessionService,
  type StudioSessionService,
} from "../services/studio-session.service";
import type { CollaboratorCapability } from "../services/project-collaborator.service";
import { hasSupaOAuthDelegationHeaders } from "../utils/bff-proof-headers";
import { isAppError } from "../utils/errors";

export const STUDIO_SESSION_COOKIE = "__Host-supacloud_session";

const INVITATION_ACCEPT_PATHS = [
  /^\/v1\/projects\/[^/]+\/organizations\/[^/]+\/invitations\/[^/]+\/accept$/,
  /^\/v1\/projects\/[^/]+\/collaborator-invitations\/[^/]+\/accept$/,
] as const;

export function isInvitationAcceptanceRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== "POST") return false;
  if (hasSupaOAuthDelegationHeaders(request)) return false;
  const pathname = new URL(request.url).pathname;
  return INVITATION_ACCEPT_PATHS.some((pattern) => pattern.test(pathname));
}

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
  | { role: "master"; principalId: "master" }
  | { role: "admin"; source: "bearer" | "cookie"; principalId: string }
  | { role: "project"; ref: string; principalId: string };

type AuthFailure = { status: number; body: { error: string } };

type CapabilityFamily = {
  read: CollaboratorCapability;
  manage: CollaboratorCapability;
};

type CapabilityFamilyRule = CapabilityFamily & {
  prefixes: readonly string[];
  pattern?: RegExp;
};

const CAPABILITY_FAMILY_RULES: readonly CapabilityFamilyRule[] = [
  {
    prefixes: ["/rbac"],
    pattern: /^\/(auth\/users\/[^/]+\/(roles|permissions|organizations)|organizations\/[^/]+\/roles)(?:\/|$)/,
    read: "roles.read",
    manage: "roles.manage",
  },
  { prefixes: ["/organizations"], read: "organizations.read", manage: "organizations.manage" },
  { prefixes: ["/collaborators", "/collaborator-invitations"], read: "tenant.members.read", manage: "tenant.members.manage" },
  { prefixes: ["/auth/oauth-clients"], read: "applications.read", manage: "applications.manage" },
  { prefixes: ["/auth/users", "/auth/generate_link"], read: "users.read", manage: "users.manage" },
  {
    prefixes: ["/auth/providers", "/auth/custom-providers", "/auth/supported-providers", "/auth/studio/providers", "/auth/sso", "/auth/china", "/auth/wechat"],
    read: "connectors.read",
    manage: "connectors.manage",
  },
  {
    prefixes: ["/auth/config", "/auth/hooks", "/auth/factors", "/auth/oauth-server", "/control-secrets", "/database/webhooks", "/network-restrictions"],
    read: "security.read",
    manage: "security.manage",
  },
  { prefixes: ["/capabilities", "/auth/runtime"], read: "tenant.capabilities.read", manage: "tenant.capabilities.manage" },
  { prefixes: ["/domains", "/custom-hostname", "/vanity-subdomain"], read: "tenant.domains.read", manage: "tenant.domains.manage" },
  {
    prefixes: ["/settings", "/api-keys", "/config", "/gateway", "/secrets", "/auth/template", "/postgrest", "/pgbouncer"],
    read: "tenant.config.read",
    manage: "tenant.config.manage",
  },
  { prefixes: ["/database/migrations"], read: "database.migrations.read", manage: "database.migrations.manage" },
  {
    prefixes: [
      "/auto-branching", "/backups", "/branches", "/dashboard", "/database", "/diagnostics",
      "/cache", "/extensions", "/frontend", "/functions", "/log-drains", "/logs", "/pg-meta", "/scaling",
      "/mutations", "/pipelines", "/scheduled-functions", "/services", "/storage", "/task-events", "/tasks", "/types",
    ],
    read: "operations.read",
    manage: "operations.manage",
  },
  {
    prefixes: ["/studio-metrics", "/pause", "/restore", "/restart", "/read-replicas", "/endpoint", "/upgrade", "/upgrade-status", "/enforced"],
    read: "project.read",
    manage: "project.manage",
  },
];

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function requestCapability(
  request: Request,
  family: CapabilityFamily,
): CollaboratorCapability {
  return ["GET", "HEAD"].includes(request.method.toUpperCase())
    ? family.read
    : family.manage;
}

function projectRelativePath(request: Request, ref: string): string | null {
  const pathname = new URL(request.url).pathname;
  const projectPrefix = `/v1/projects/${ref}`;
  if (pathname === projectPrefix) return "";
  return pathname.startsWith(`${projectPrefix}/`)
    ? pathname.slice(projectPrefix.length)
    : null;
}

function auditCapability(request: Request, pathname: string): CollaboratorCapability | null {
  if (!pathMatchesPrefix(pathname, "/audit")) return null;
  if (pathMatchesPrefix(pathname, "/audit/exports")) return "audit.export";
  if (pathname === "/audit/events" && request.method.toUpperCase() === "POST") return "audit.write";
  return new URL(request.url).searchParams.get("include_sensitive") === "true"
    ? "audit.read_sensitive"
    : "audit.read";
}

function webhookCapability(request: Request, pathname: string): CollaboratorCapability | null {
  if (!pathMatchesPrefix(pathname, "/webhooks")) return null;
  if (pathname.endsWith("/replay") && request.method.toUpperCase() === "POST") {
    return "webhooks.replay";
  }
  return requestCapability(request, { read: "webhooks.read", manage: "webhooks.manage" });
}

function capabilityFamily(pathname: string): CapabilityFamily | null {
  const rule = CAPABILITY_FAMILY_RULES.find((candidate) =>
    candidate.prefixes.some((prefix) => pathMatchesPrefix(pathname, prefix))
    || candidate.pattern?.test(pathname)
  );
  return rule ? { read: rule.read, manage: rule.manage } : null;
}

export function delegatedProjectCapability(
  request: Request,
  ref: string,
): CollaboratorCapability | null {
  const pathname = projectRelativePath(request, ref);
  if (pathname === null) return null;
  if (pathname === "" || pathname === "/") {
    return requestCapability(request, { read: "project.read", manage: "project.manage" });
  }
  const exactCapability = auditCapability(request, pathname) || webhookCapability(request, pathname);
  if (exactCapability) return exactCapability;
  const family = capabilityFamily(pathname);
  return family ? requestCapability(request, family) : null;
}

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
      return { role: "admin", source: "cookie", principalId: session.username };
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
      return { role: "master", principalId: "master" };
    }
  }

  const mcpPayload = await verifyMcpToken(token);
  let role = mcpPayload?.role;
  let ref = mcpPayload?.ref;

  if (!mcpPayload && isOpaqueApiKey(token)) {
    const apiKey = await resolveProjectApiKey(token);
    if (apiKey?.role === "service_role") {
      role = "project";
      ref = apiKey.ref;
    }
  }

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
    return { role: "admin", source: "bearer", principalId: "admin" };
  }

  if (role === "project" && ref) {
    const pathRef = extractProjectRefFromPath(url.pathname);
    if (pathRef !== ref) {
      return { status: 403, body: { error: `Token scoped strictly to project ${ref}, cannot access ${url.pathname}` } };
    }
    return { role: "project", ref, principalId: `project:${ref}` };
  }

    return { status: 401, body: { error: "Invalid token" } };
  };
}

export async function getVerifiedRequestPrincipal(request: Request): Promise<{
  id: string;
  type: "master" | "admin" | "project";
} | null> {
  const auth = await getAuthContext(request);
  if ("status" in auth) return null;
  return { id: auth.principalId, type: auth.role };
}

/** Transport authentication only; delegated actor verification must wrap this result. */
export const getTransportAuthContextForDelegatedProof = createAuthResolver();

async function delegatedAuthContext(request: Request): Promise<AuthContext | AuthFailure | undefined> {
  if (!hasSupaOAuthDelegationHeaders(request)) return undefined;
  const ref = extractProjectRefFromPath(new URL(request.url).pathname);
  if (!ref) return { status: 403, body: { error: "Delegated requests require a project-scoped route" } };
  const { resolveTrustedPrincipal } = await import("../services/bff-proof.service");
  try {
    const principal = await resolveTrustedPrincipal(request, ref);
    return { role: "project", ref, principalId: principal.id };
  } catch (error: unknown) {
    if (!isAppError(error)) throw error;
    return { status: error.statusCode, body: { error: error.message } };
  }
}

export async function getAuthContext(request: Request): Promise<AuthContext | AuthFailure> {
  const delegated = await delegatedAuthContext(request);
  return delegated ?? getTransportAuthContextForDelegatedProof(request);
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

async function delegatedCapabilityFailure(
  request: Request,
  ref: string,
): Promise<AuthFailure | undefined> {
  if (!hasSupaOAuthDelegationHeaders(request)) return undefined;
  const capability = delegatedProjectCapability(request, ref);
  if (!capability) {
    return { status: 403, body: { error: "Delegated access is unavailable for this project route" } };
  }
  try {
    await enforceDelegatedCapability(request, ref, capability);
    return undefined;
  } catch (error: unknown) {
    if (!isAppError(error)) throw error;
    return { status: error.statusCode, body: { error: error.message } };
  }
}

async function enforceDelegatedCapability(
  request: Request,
  ref: string,
  capability: CollaboratorCapability,
): Promise<void> {
  const { resolveTrustedPrincipal } = await import("../services/bff-proof.service");
  const principal = await resolveTrustedPrincipal(request, ref);
  if (capability === "audit.write" && ["user", "system"].includes(principal.type)) return;
  const { requireCapability } = await import("../services/project-collaborator.service");
  await requireCapability(ref, principal, capability);
}

export async function requireProjectOrAdminAuth(request: Request, ref: string): Promise<{ status: number; body: { error: string } } | undefined> {
  const auth = await getAuthContext(request);
  if ("status" in auth) return auth;
  const delegatedFailure = await delegatedCapabilityFailure(request, ref);
  if (delegatedFailure) return delegatedFailure;
  if (auth.role === "master" || auth.role === "admin") return undefined;
  if (auth.role === "project" && auth.ref === ref) return undefined;
  return { status: 403, body: { error: "Project service role or admin privileges required" } };
}
