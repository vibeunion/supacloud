import { Elysia, t } from "elysia";
import { logAuditEvent } from "../services/audit.service";
import {
  studioSessionService,
  type StudioSessionService,
} from "../services/studio-session.service";
import {
  STUDIO_SESSION_COOKIE,
  isSameOriginStudioRequest,
  readStudioSessionToken,
} from "../middleware/auth";
import { resolveProxyClientIp } from "../utils/client-ip";

const COOKIE_MAX_AGE_SECONDS = 15 * 60;

type AuditInput = Parameters<typeof logAuditEvent>[0];

type StudioAuthRoutesOptions = {
  service?: StudioSessionService;
  audit?: (input: AuditInput) => Promise<void>;
};

function sessionCookie(token: string, maxAge = COOKIE_MAX_AGE_SECONDS): string {
  return [
    `${STUDIO_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function isCrossOriginBrowserRequest(request: Request): boolean {
  if (request.headers.has("origin") && !isSameOriginStudioRequest(request)) {
    return true;
  }
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return Boolean(fetchSite && fetchSite !== "same-origin" && fetchSite !== "none");
}

export function createStudioAuthRoutes(options: StudioAuthRoutesOptions = {}) {
  const service = options.service ?? studioSessionService;
  const audit = options.audit ?? logAuditEvent;

  return new Elysia({ name: "studio-auth-routes" })
    .post("/auth/login", async ({ body, request, set }) => {
      if (isCrossOriginBrowserRequest(request)) {
        set.status = 403;
        await audit({
          request,
          status: 403,
          action: "studio_login_csrf_denied",
          metadata: {},
        });
        return {
          success: false,
          message: "Cross-origin login request denied",
          code: "403",
        };
      }
      const result = await service.login({
        username: body.username,
        password: body.password,
        clientIp: resolveProxyClientIp(request),
        userAgent: request.headers.get("user-agent") || "",
      });

      if (!result.ok) {
        const locked = result.reason === "locked";
        set.status = locked ? 429 : 401;
        if (locked && result.retryAfterSeconds) {
          set.headers["retry-after"] = String(result.retryAfterSeconds);
        }
        await audit({
          request,
          status: Number(set.status),
          action: locked ? "studio_login_locked" : "studio_login_failed",
          metadata: { username: body.username.trim().toLowerCase() },
        });
        return {
          success: false,
          message: locked ? "Too many failed login attempts" : "Invalid username or password",
          code: String(set.status),
        };
      }

      set.headers["set-cookie"] = sessionCookie(result.token);
      await audit({
        request,
        status: 200,
        action: "studio_login_succeeded",
        metadata: { username: result.username },
      });
      return {
        success: true,
        username: result.username,
        expires_at: result.expiresAt.toISOString(),
      };
    }, {
      body: t.Object({
        username: t.String({ minLength: 1, maxLength: 320 }),
        password: t.String({ minLength: 1, maxLength: 4096 }),
      }),
      detail: { tags: ["auth"], summary: "Studio login" },
    })
    .post("/auth/refresh", async ({ request, set }) => {
      if (!isSameOriginStudioRequest(request)) {
        set.status = 403;
        return { success: false, message: "Cross-origin session request denied", code: "403" };
      }
      const token = readStudioSessionToken(request);
      const refreshed = token
        ? await service.refresh({
          token,
          clientIp: resolveProxyClientIp(request),
          userAgent: request.headers.get("user-agent") || "",
        })
        : null;
      if (!refreshed) {
        set.status = 401;
        set.headers["set-cookie"] = sessionCookie("", 0);
        return { success: false, message: "Session expired", code: "401" };
      }
      set.headers["set-cookie"] = sessionCookie(refreshed.token);
      await audit({
        request,
        status: 200,
        action: "studio_session_refreshed",
        metadata: { username: refreshed.session.username },
      });
      return {
        success: true,
        username: refreshed.session.username,
        expires_at: refreshed.session.expiresAt.toISOString(),
      };
    }, {
      detail: { tags: ["auth"], summary: "Refresh Studio session" },
    })
    .get("/auth/session", async ({ request, set }) => {
      const token = readStudioSessionToken(request);
      const session = token ? await service.verify(token) : null;
      if (!session) {
        set.status = 401;
        return { valid: false, message: "Session expired", code: "401" };
      }
      return {
        valid: true,
        username: session.username,
        expires_at: session.expiresAt.toISOString(),
      };
    }, {
      detail: { tags: ["auth"], summary: "Inspect Studio session" },
    })
    .post("/auth/logout", async ({ request, set }) => {
      if (!isSameOriginStudioRequest(request)) {
        set.status = 403;
        return { success: false, message: "Cross-origin session request denied", code: "403" };
      }
      const token = readStudioSessionToken(request);
      if (token) await service.revoke(token);
      set.headers["set-cookie"] = sessionCookie("", 0);
      await audit({ request, status: 200, action: "studio_logout", metadata: {} });
      return { success: true };
    }, {
      detail: { tags: ["auth"], summary: "Studio logout" },
    });
}

export const studioAuthRoutes = createStudioAuthRoutes();
