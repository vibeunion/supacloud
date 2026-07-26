import { randomUUID } from "node:crypto";
import { Elysia, t, status } from "elysia";
import { config } from "../config";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { getProjectDb, resolveDbName, sql as metaSql } from "../db";
import { resolveTenantPorts, normalizeProjectRoutingConfig } from "../utils/project-routing";
import { normalizeProjectConfig, normalizeThirdPartyAuthConfig } from "../utils/project-config";
import { requireAuthRuntimeManagement } from "./auth-runtime";
import { gotrueGrantsService } from "../services/gotrue-grants.service";
import { CapabilityUnavailableError, isAppError } from "../utils/errors";
import {
  beginUserDeletion,
  completeUserDeletion,
  failUserDeletion,
  markUserDeletionStarted,
  recordUserDeletionUncertainty,
  resumeUserDeletionAfterReconcile,
  type BeginUserDeletionInput,
  type UserDeletionOperationInput,
} from "../services/user-safety.service";
import {
  GOTRUE_USER_ID_PATTERN,
  normalizedGoTrueUserId,
} from "../utils/project-user-lifecycle";

function gotrueGrantError(error: unknown) {
  if (isAppError(error)) return status(error.statusCode, error.toJSON());
  throw error;
}

function unavailableGoTrueAdminCapability(capability: string, reasonCode: string) {
  const error = new CapabilityUnavailableError(capability, reasonCode);
  return status(error.statusCode, error.toJSON());
}

function trustedDirectGoTrueUrl(request: Request): string | null {
  if (request.headers.get("authorization") !== `Bearer ${config.masterToken}`) return null;
  const candidate = request.headers.get("x-supacloud-direct-gotrue-url");
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && /^\d+$/.test(url.port)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function usesExternalAuthEndpoint(rawConfig: unknown): boolean {
  const projectConfig = normalizeProjectConfig(rawConfig);
  const auth = projectConfig.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  const thirdPartyAuth = normalizeThirdPartyAuthConfig(
    (auth as Record<string, unknown>).third_party_auth,
  );
  return thirdPartyAuth.enabled
    && thirdPartyAuth.auth_endpoint_mode === "external"
    && Boolean(thirdPartyAuth.auth_upstream);
}

async function getGoTrueAdminContext(ref: string, directApiUrl?: string | null) {
  const project = await projectService.getProject(ref);
  if (!project) return null;

  const serviceRoleKey = await resolveProjectServiceRoleKey(ref);
  if (!serviceRoleKey) return null;

  const projectUsesExternalAuth = usesExternalAuthEndpoint(project.config);
  if (directApiUrl) {
    return {
      project,
      apiUrl: directApiUrl,
      serviceRoleKey,
      externalAuthEndpoint: projectUsesExternalAuth,
    };
  }

  let apiUrl: string;
  let externalAuthEndpoint = projectUsesExternalAuth;
  try {
    const rows = await metaSql`
      SELECT config FROM projects WHERE ref = ${ref} AND deleted_at IS NULL LIMIT 1
    `;
    const projectConfig = normalizeProjectConfig(rows[0]?.config);
    externalAuthEndpoint = externalAuthEndpoint || usesExternalAuthEndpoint(projectConfig);
    const routingConfig = normalizeProjectRoutingConfig(projectConfig);
    const ports = resolveTenantPorts(routingConfig);
    apiUrl = ports?.gotruePort
      ? `http://127.0.0.1:${ports.gotruePort}`
      : `http://${config.managementApiInternal}/auth/v1`;
  } catch {
    apiUrl = `http://${config.managementApiInternal}/auth/v1`;
  }

  return { project, apiUrl, serviceRoleKey, externalAuthEndpoint };
}

const GOTRUE_ADMIN_TIMEOUT_MS = 10_000;

async function gotrueFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: init?.signal || AbortSignal.timeout(GOTRUE_ADMIN_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("self signed certificate") || msg.includes("CERT") || msg.includes("ECONNREFUSED") || msg.includes("connect")) {
      throw new Error(`Auth service unavailable: ${msg}`);
    }
    throw err;
  }
}

async function readGoTrueError(res: Response, fallbackMessage: string) {
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (parsed !== null && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    return {
      message: readOptionalString(body.msg) ?? readOptionalString(body.message) ?? fallbackMessage,
      code: readOptionalString(body.code) ?? String(res.status)
    };
  }

  return {
    message: text.trim().length > 0 && text.trim() !== "null" ? text.trim() : fallbackMessage,
    code: String(res.status)
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

type GoTrueDeletionReadback =
  | { state: "deleted" }
  | { state: "active" }
  | { state: "unavailable"; error: string };

interface GoTrueDeletionReadbackInput {
  url: string;
  serviceRoleKey: string;
  projectRef: string;
  shouldSoftDelete: boolean;
}

async function readBackGoTrueUserDeletion(
  input: GoTrueDeletionReadbackInput,
): Promise<GoTrueDeletionReadback> {
  let response: Response;
  try {
    response = await gotrueFetch(input.url, {
      headers: {
        apikey: input.serviceRoleKey,
        Authorization: `Bearer ${input.serviceRoleKey}`,
        "x-project-ref": input.projectRef,
      },
    });
  } catch (error) {
    return { state: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }

  if (response.status === 404 || response.status === 410) return { state: "deleted" };
  if (!response.ok) {
    const upstreamError = await readGoTrueError(response, "Failed to verify GoTrue user deletion");
    return { state: "unavailable", error: upstreamError.message };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return { state: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
  if (input.shouldSoftDelete && payload !== null && typeof payload === "object") {
    const deletedAt = readOptionalString((payload as Record<string, unknown>).deleted_at);
    if (deletedAt) return { state: "deleted" };
  }
  return { state: "active" };
}

async function persistUserDeletionFailure(
  input: UserDeletionOperationInput,
  error: string,
): Promise<void> {
  const persisted = await failUserDeletion(input, error);
  if (!persisted) throw new Error("GoTrue user deletion failure could not be persisted");
}

async function rememberUserDeletionUncertainty(
  input: UserDeletionOperationInput,
  error: string,
): Promise<void> {
  try {
    await recordUserDeletionUncertainty(input, error);
  } catch (persistenceError) {
    logger.error("[auth-users] Failed to persist uncertain GoTrue deletion state", {
      projectRef: input.projectRef,
      userId: input.userId,
      error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
    });
  }
}

function deletionStateUnavailable(reasonCode: string) {
  return status(503, {
    code: "SERVICE_UNAVAILABLE",
    message: "GoTrue user deletion state could not be safely confirmed",
    reason_code: reasonCode,
  });
}

const FORBIDDEN_USER_MUTATION_KEYS = new Set([
  "id",
  "role",
  "password_hash",
  "current_password",
  "nonce",
  "permissions",
  "roles",
  "organizations",
  "organization_ids",
  "tenant_permissions",
  "is_super_admin",
]);

const RESERVED_APP_METADATA_KEYS = new Set([
  "supaoauth",
  "role",
  "permissions",
  "roles",
  "organizations",
  "organization_ids",
  "tenant_permissions",
  "is_super_admin",
]);

const ALLOWED_USER_MUTATION_KEYS = new Set([
  "email",
  "phone",
  "password",
  "email_confirm",
  "phone_confirm",
  "user_metadata",
  "app_metadata",
  "ban_duration",
  "redirect_to",
]);

function normalizedMutationKey(key: string): string {
  return key.trim().replaceAll(/[-\s]/g, "_").replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function validateUserMutation(body: Record<string, unknown>):
  | { ok: true }
  | { ok: false; field: string } {
  for (const key of Object.keys(body)) {
    const normalized = normalizedMutationKey(key);
    if (
      FORBIDDEN_USER_MUTATION_KEYS.has(normalized) ||
      !ALLOWED_USER_MUTATION_KEYS.has(normalized)
    ) {
      return { ok: false, field: key };
    }
  }

  if (body.app_metadata !== undefined) {
    if (
      body.app_metadata === null ||
      typeof body.app_metadata !== "object" ||
      Array.isArray(body.app_metadata)
    ) {
      return { ok: false, field: "app_metadata" };
    }
    for (const key of Object.keys(body.app_metadata as Record<string, unknown>)) {
      if (RESERVED_APP_METADATA_KEYS.has(normalizedMutationKey(key))) {
        return { ok: false, field: `app_metadata.${key}` };
      }
    }
  }

  return { ok: true };
}

function forbiddenUserMutation(field: string) {
  return status(400, {
    code: "FORBIDDEN_USER_MUTATION",
    message: `Field ${field} is controlled by GoTrue or the SupaOAuth authorization boundary`,
    field,
  });
}

function goTrueUserMutationBody(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => ALLOWED_USER_MUTATION_KEYS.has(normalizedMutationKey(key))),
  );
}

type GoTrueSessionRow = {
  session_id: string;
  created_at: Date;
  updated_at: Date;
  aal: string;
  amr: Array<{ method: string; created_at: string }>;
  total_count: number | string;
};

async function listGoTrueUserSessions(
  ref: string,
  userId: string,
  page: number,
  limit: number,
) {
  const projectDb = getProjectDb(await resolveDbName(ref));
  const offset = (page - 1) * limit;
  const rows = await projectDb`
    SELECT
      session.id::text AS session_id,
      session.created_at,
      session.updated_at,
      COALESCE(session.aal::text, 'aal1') AS aal,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'method', claim.authentication_method,
            'created_at', claim.created_at
          ) ORDER BY claim.created_at ASC
        )
        FROM auth.mfa_amr_claims AS claim
        WHERE claim.session_id = session.id
      ), '[]'::jsonb) AS amr,
      COUNT(*) OVER() AS total_count
    FROM auth.sessions AS session
    WHERE session.user_id = ${userId}::uuid
    ORDER BY session.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  ` as GoTrueSessionRow[];
  return {
    items: rows.map(({ total_count: _totalCount, ...session }) => session),
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    page,
    limit,
  };
}

type AuthUserSearchRow = {
  id: string;
  aud: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  created_at: Date | string;
  last_sign_in_at: Date | string | null;
  total_count: string | number;
};

type UserListPaginationQuery = {
  skip?: string;
  limit?: string;
  page?: string;
  per_page?: string;
  _page?: string;
  _limit?: string;
};

function userListPagination(query: UserListPaginationQuery) {
  // Cases: missing/non-numeric values use defaults; zero/negative values start
  // at page one; oversized pages are bounded before the tenant query runs.
  const requestedLimit = Number.parseInt(query.per_page || query._limit || query.limit || "50", 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50));
  const requestedPage = Number.parseInt(query.page || query._page || "", 10);
  const skip = Math.max(0, Number.parseInt(query.skip || "0", 10) || 0);
  const fallbackPage = Math.floor(skip / limit) + 1;
  return { limit, page: Math.max(1, Number.isFinite(requestedPage) ? requestedPage : fallbackPage) };
}

async function searchGoTrueUsers(ref: string, search: string, page: number, limit: number) {
  const projectDb = getProjectDb(await resolveDbName(ref));
  const offset = (page - 1) * limit;
  const pattern = `%${search}%`;
  const rows = await projectDb`
    SELECT
      user_record.id::text AS id,
      user_record.aud::text AS aud,
      user_record.role::text AS role,
      user_record.email,
      user_record.phone,
      user_record.raw_app_meta_data,
      user_record.raw_user_meta_data,
      user_record.created_at,
      user_record.last_sign_in_at,
      COUNT(*) OVER() AS total_count
    FROM auth.users AS user_record
    WHERE user_record.email ILIKE ${pattern}
       OR user_record.phone ILIKE ${pattern}
       OR user_record.id::text ILIKE ${pattern}
    ORDER BY user_record.created_at DESC, user_record.id DESC
    LIMIT ${limit} OFFSET ${offset}
  ` as AuthUserSearchRow[];

  return {
    users: rows.map(({ total_count: _totalCount, ...user }) => user),
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    page,
    per_page: limit,
  };
}

/**
 * User Management routes — Admin API proxy to GoTrue
 */
export const userManagementRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .onBeforeHandle(requireAuthRuntimeManagement("users"))
  .get(
    "/users",
    async ({ params, query, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const { limit, page } = userListPagination(query);
      // The generic data provider encodes the Auth page's email search as
      // `email_like`, while GoTrue's Admin API has no search parameter. Search
      // the tenant's authoritative auth.users relation instead of silently
      // dropping the UI filter or pretending GoTrue supports `q`/`filter`.
      const search = query.search || query.email_like;
      if (search) return searchGoTrueUsers(params.ref, String(search), page, limit);
      
      const searchParams = new URLSearchParams();
      searchParams.set("page", String(page));
      searchParams.set("per_page", String(limit));

      const res = await gotrueFetch(`${apiUrl}/admin/users?${searchParams.toString()}`, {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to fetch users");
      }

      const linkHeader = res.headers.get("link");
      if (linkHeader) set.headers["link"] = linkHeader;
      const totalHeader = res.headers.get("x-total-count");
      if (totalHeader) set.headers["x-total-count"] = totalHeader;

      const d = await res.json() as Record<string, unknown>;
      
      const users = Array.isArray(d) ? d : d.users;
      if (!Array.isArray(users)) return d;

      const list = users as unknown[];
      let nextPage: number | null = null;
      let lastPage: number | null = null;
      if (linkHeader) {
        const lastMatch = linkHeader.match(/page=(\d+)[^>]*>; rel="last"/);
        const nextMatch = linkHeader.match(/page=(\d+)[^>]*>; rel="next"/);
        if (lastMatch) lastPage = Number.parseInt(lastMatch[1], 10);
        if (nextMatch) nextPage = Number.parseInt(nextMatch[1], 10);
      }
      const parsedTotal = totalHeader ? Number(totalHeader) : Number.NaN;

      return {
        ...(Array.isArray(d) ? { aud: "authenticated" } : d),
        users: list,
        next_page: nextPage,
        last_page: lastPage,
        // GoTrue exposes the count in a response header. Include it in the
        // JSON envelope so the data provider can render pagination correctly.
        total: Number.isFinite(parsedTotal) ? parsedTotal : list.length,
      };
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object({
        skip: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
        _page: t.Optional(t.String()),
        _limit: t.Optional(t.String()),
        _sort: t.Optional(t.String()),
        _order: t.Optional(t.String()),
        search: t.Optional(t.String()),
        email_like: t.Optional(t.String()),
        q: t.Optional(t.String()),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "List users" },
    }
  )
  .post(
    "/users",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const validation = validateUserMutation(body as Record<string, unknown>);
      if (!validation.ok) return forbiddenUserMutation(validation.field);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify({
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.password !== undefined ? { password: body.password } : {}),
          ...(body.email_confirm !== undefined ? { email_confirm: body.email_confirm } : {}),
          ...(body.phone_confirm !== undefined ? { phone_confirm: body.phone_confirm } : {}),
          ...(body.user_metadata !== undefined ? { user_metadata: body.user_metadata } : {}),
          ...(body.app_metadata !== undefined ? { app_metadata: body.app_metadata } : {}),
          ...(body.ban_duration !== undefined ? { ban_duration: body.ban_duration } : {})
        })
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to create user");
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        password: t.Optional(t.String()),
        email_confirm: t.Optional(t.Boolean()),
        phone_confirm: t.Optional(t.Boolean()),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
        ban_duration: t.Optional(t.String()),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "Create user" },
    }
  )

  .post(
    "/users/invite",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const validation = validateUserMutation(body as Record<string, unknown>);
      if (!validation.ok) return forbiddenUserMutation(validation.field);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify({
          email: body.email,
          data: body.user_metadata || {},
          ...(body.redirectTo ? { redirect_to: body.redirectTo } : {}),
          ...(body.app_metadata ? { app_metadata: body.app_metadata } : {}),
        })
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to invite user");
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        email: t.String(),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
        redirectTo: t.Optional(t.String()),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "Invite user by email" },
    }
  )

  .get(
    "/users/:id/sessions",
    async ({ params, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      if (!GOTRUE_USER_ID_PATTERN.test(params.id)) {
        return status(400, { code: "VALIDATION_ERROR", message: "GoTrue user id must be a UUID" });
      }
      const page = Math.max(1, Number.parseInt(query.page || "1", 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit || "50", 10) || 50));
      return listGoTrueUserSessions(params.ref, params.id, page, limit);
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "List authoritative GoTrue sessions and AAL for a user" },
    },
  )

  .post(
    "/users/:id/sessions/:sessionId/revoke",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      if (!GOTRUE_USER_ID_PATTERN.test(params.id) || !GOTRUE_USER_ID_PATTERN.test(params.sessionId)) {
        return status(400, { code: "VALIDATION_ERROR", message: "GoTrue user and session ids must be UUIDs" });
      }
      return unavailableGoTrueAdminCapability(
        "gotrue_admin_session_revoke",
        "gotrue_admin_session_revoke_unavailable",
      );
    },
    {
      params: t.Object({ ref: t.String(), id: t.String(), sessionId: t.String() }),
      detail: { hide: true },
    },
  )

  .delete(
    "/users/:id/identities/:identityId",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      if (!GOTRUE_USER_ID_PATTERN.test(params.id) || !GOTRUE_USER_ID_PATTERN.test(params.identityId)) {
        return status(400, { code: "VALIDATION_ERROR", message: "GoTrue user and identity ids must be UUIDs" });
      }
      return unavailableGoTrueAdminCapability(
        "gotrue_admin_identity_unlink",
        "gotrue_admin_identity_unlink_unavailable",
      );
    },
    {
      params: t.Object({ ref: t.String(), id: t.String(), identityId: t.String() }),
      detail: { hide: true },
    },
  )

  .get(
    "/users/:id/grants",
    async ({ params, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      try {
        return await gotrueGrantsService.list(params.ref, params.id, query.include_revoked === "true");
      } catch (error) {
        return gotrueGrantError(error);
      }
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      query: t.Object({ include_revoked: t.Optional(t.String()) }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "List authoritative GoTrue OAuth grants for a user" },
    },
  )

  .delete(
    "/users/:id/grants/:clientId",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      try {
        return await gotrueGrantsService.revoke();
      } catch (error) {
        return gotrueGrantError(error);
      }
    },
    {
      params: t.Object({ ref: t.String(), id: t.String(), clientId: t.String() }),
      detail: { hide: true },
    },
  )

  .get(
    "/oauth-clients/:clientId/grants",
    async ({ params, query, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      try {
        return await gotrueGrantsService.listByClient(
          params.ref,
          params.clientId,
          query.include_revoked === "true",
        );
      } catch (error) {
        return gotrueGrantError(error);
      }
    },
    {
      params: t.Object({ ref: t.String(), clientId: t.String() }),
      query: t.Object({ include_revoked: t.Optional(t.String()) }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "List authoritative GoTrue OAuth grants for an application" },
    },
  )

  .post(
    "/users/:id/suspend",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) return status(404, { message: "Project service role key not found", code: "404" });
      const res = await gotrueFetch(`${ctx.apiUrl}/admin/users/${params.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          apikey: ctx.serviceRoleKey,
          Authorization: `Bearer ${ctx.serviceRoleKey}`,
          "x-project-ref": params.ref,
        },
        body: JSON.stringify({ ban_duration: "876000h" }),
      });
      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to suspend user");
      }
      return res.json();
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      body: t.Optional(t.Record(t.String(), t.Unknown())),
      detail: { tags: ["auth"], summary: "Suspend a GoTrue user" },
    },
  )

  .post(
    "/users/:id/unsuspend",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) return status(404, { message: "Project service role key not found", code: "404" });
      const res = await gotrueFetch(`${ctx.apiUrl}/admin/users/${params.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          apikey: ctx.serviceRoleKey,
          Authorization: `Bearer ${ctx.serviceRoleKey}`,
          "x-project-ref": params.ref,
        },
        body: JSON.stringify({ ban_duration: "none" }),
      });
      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to unsuspend user");
      }
      return res.json();
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      detail: { tags: ["auth"], summary: "Restore a suspended GoTrue user" },
    },
  )

  .post(
    "/users/:id/mfa/:factorId/reset",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) return status(404, { message: "Project service role key not found", code: "404" });
      const res = await gotrueFetch(
        `${ctx.apiUrl}/admin/users/${params.id}/factors/${params.factorId}`,
        {
          method: "DELETE",
          headers: {
            apikey: ctx.serviceRoleKey,
            Authorization: `Bearer ${ctx.serviceRoleKey}`,
            "x-project-ref": params.ref,
          },
        },
      );
      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to unenroll MFA factor");
      }
      const payload = await res.json().catch(() => ({}));
      return { reset: true, factor_id: params.factorId, result: payload };
    },
    {
      params: t.Object({ ref: t.String(), id: t.String(), factorId: t.String() }),
      detail: { tags: ["auth"], summary: "Unenroll a GoTrue MFA factor" },
    },
  )

  .get(
    "/users/:id",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users/${params.id}`, {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "User not found");
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["auth"], summary: "Get user" },
    }
  )

  .put(
    "/users/:id",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const validation = validateUserMutation(body as Record<string, unknown>);
      if (!validation.ok) return forbiddenUserMutation(validation.field);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users/${params.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify(goTrueUserMutationBody(body as Record<string, unknown>))
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to update user");
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        password: t.Optional(t.String()),
        email_confirm: t.Optional(t.Boolean()),
        phone_confirm: t.Optional(t.Boolean()),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
        ban_duration: t.Optional(t.String()),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "Replace user" },
    }
  )

  .patch(
    "/users/:id",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const validation = validateUserMutation(body as Record<string, unknown>);
      if (!validation.ok) return forbiddenUserMutation(validation.field);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users/${params.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify(goTrueUserMutationBody(body as Record<string, unknown>)),
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to update user");
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      body: t.Object({
        email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        password: t.Optional(t.String()),
        email_confirm: t.Optional(t.Boolean()),
        phone_confirm: t.Optional(t.Boolean()),
        user_metadata: t.Optional(t.Any()),
        app_metadata: t.Optional(t.Any()),
        ban_duration: t.Optional(t.String()),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "Update user" },
    }
  )

  .delete(
    "/users/:id",
    async ({ params, set, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      if (!GOTRUE_USER_ID_PATTERN.test(params.id)) {
        return status(400, { code: "VALIDATION_ERROR", message: "GoTrue user id must be a UUID" });
      }
      const ctx = await getGoTrueAdminContext(params.ref, trustedDirectGoTrueUrl(request));
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      if (ctx.externalAuthEndpoint) {
        return unavailableGoTrueAdminCapability(
          "auth.user.delete",
          "external_auth_user_deletion_unavailable",
        );
      }
      const { apiUrl, serviceRoleKey } = ctx;
      const userId = normalizedGoTrueUserId(params.id)!;
      const deletionInput: BeginUserDeletionInput = {
        projectRef: params.ref,
        userId,
        requestId: request.headers.get("x-request-id")?.trim() || randomUUID(),
        shouldSoftDelete: body?.should_soft_delete === true,
      };
      const url = `${apiUrl}/admin/users/${userId}`;

      let deletionIntent: Awaited<ReturnType<typeof beginUserDeletion>>;
      try {
        deletionIntent = await beginUserDeletion(deletionInput);
      } catch (error) {
        logger.warn("[auth-users] Failed to persist GoTrue user deletion intent", {
          projectRef: params.ref,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return status(503, {
          code: "SERVICE_UNAVAILABLE",
          message: "User deletion safety state is unavailable; GoTrue was not called",
          reason_code: "user_deletion_fence_unavailable",
        });
      }
      if (deletionIntent.state === "blocked") {
        return status(409, {
          code: "USER_HAS_ACTIVE_TASKS",
          message: "User deletion is blocked while background tasks are active",
          active_task_count: deletionIntent.activeTaskCount,
          active_tasks: deletionIntent.activeTasks,
        });
      }
      if (deletionIntent.state === "in_progress") {
        return status(409, {
          code: "USER_DELETION_IN_PROGRESS",
          message: "A GoTrue user deletion is already in progress",
          deletion_status: deletionIntent.status,
          request_id: deletionIntent.requestId,
        });
      }
      if (deletionIntent.state === "already_deleted") {
        return {
          id: userId,
          deleted: true,
          should_soft_delete: deletionIntent.shouldSoftDelete,
          deleted_at: deletionIntent.completedAt,
        };
      }

      let operationId: string;
      if (deletionIntent.state === "reconcile") {
        const staleOperation: UserDeletionOperationInput = {
          projectRef: params.ref,
          userId,
          operationId: deletionIntent.operationId,
        };
        const readback = await readBackGoTrueUserDeletion({
          url,
          serviceRoleKey,
          projectRef: params.ref,
          shouldSoftDelete: deletionIntent.shouldSoftDelete,
        });
        if (readback.state === "unavailable") {
          await rememberUserDeletionUncertainty(staleOperation, readback.error);
          return deletionStateUnavailable("gotrue_user_deletion_reconcile_unavailable");
        }
        if (readback.state === "deleted") {
          try {
            await completeUserDeletion(staleOperation);
          } catch (error) {
            logger.error("[auth-users] Reconciled GoTrue deletion could not be persisted", {
              projectRef: params.ref,
              userId,
              error: error instanceof Error ? error.message : String(error),
            });
            return deletionStateUnavailable("user_deletion_completion_unavailable");
          }
          return { id: userId, deleted: true, deletion_status: "deleted" };
        }

        const resumed = await resumeUserDeletionAfterReconcile(
          deletionInput,
          deletionIntent.operationId,
        );
        if (resumed.state === "blocked") {
          return status(409, {
            code: "USER_HAS_ACTIVE_TASKS",
            message: "User deletion is blocked while background tasks are active",
            active_task_count: resumed.activeTaskCount,
            active_tasks: resumed.activeTasks,
          });
        }
        if (resumed.state === "operation_changed") {
          return status(409, {
            code: "USER_DELETION_IN_PROGRESS",
            message: "The GoTrue user deletion operation changed during reconciliation",
          });
        }
        operationId = resumed.operationId;
      } else {
        operationId = deletionIntent.operationId;
      }

      const deletionOperation: UserDeletionOperationInput = {
        projectRef: params.ref,
        userId,
        operationId,
      };

      try {
        await markUserDeletionStarted(deletionOperation);
      } catch (error) {
        logger.warn("[auth-users] Failed to mark GoTrue user deletion as started", {
          projectRef: params.ref,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return deletionStateUnavailable("user_deletion_state_unavailable");
      }

      let deleteResponse: Response | null = null;
      let deleteError: { message: string; code: string } | null = null;
      let deletionPayload: unknown = null;
      try {
        deleteResponse = await gotrueFetch(url, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "x-project-ref": params.ref,
          },
          body: body && Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
        });
        if (deleteResponse.ok) {
          deletionPayload = await deleteResponse.json().catch(() => ({}));
        } else {
          deleteError = await readGoTrueError(deleteResponse, "Failed to delete user");
        }
      } catch (error) {
        deleteError = {
          message: error instanceof Error ? error.message : String(error),
          code: "GOTRUE_UNAVAILABLE",
        };
      }

      const readback = await readBackGoTrueUserDeletion({
        url,
        serviceRoleKey,
        projectRef: params.ref,
        shouldSoftDelete: deletionInput.shouldSoftDelete,
      });
      if (readback.state === "unavailable") {
        const uncertainError = [deleteError?.message, readback.error].filter(Boolean).join("; ");
        await rememberUserDeletionUncertainty(deletionOperation, uncertainError);
        logger.warn("[auth-users] GoTrue user deletion read-back is unavailable", {
          projectRef: params.ref,
          userId,
          error: readback.error,
        });
        return deletionStateUnavailable("gotrue_user_deletion_readback_unavailable");
      }
      if (readback.state === "active") {
        const failureMessage = deleteError?.message || "GoTrue user remained active after deletion";
        if (!deleteResponse) {
          await rememberUserDeletionUncertainty(deletionOperation, failureMessage);
          return deletionStateUnavailable("gotrue_user_deletion_transport_uncertain");
        }
        try {
          await persistUserDeletionFailure(deletionOperation, failureMessage);
        } catch (error) {
          logger.error("[auth-users] Failed to persist active GoTrue user read-back", {
            projectRef: params.ref,
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
          return deletionStateUnavailable("user_deletion_failure_state_unavailable");
        }
        if (deleteResponse && !deleteResponse.ok && deleteError) {
          set.status = deleteResponse.status;
          return deleteError;
        }
        return status(502, {
          code: "GOTRUE_DELETION_NOT_CONFIRMED",
          message: failureMessage,
          reason_code: "gotrue_user_still_active",
        });
      }

      try {
        await completeUserDeletion(deletionOperation);
      } catch (error) {
        logger.error("[auth-users] GoTrue deletion succeeded but completion state could not be persisted", {
          projectRef: params.ref,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return deletionStateUnavailable("user_deletion_completion_unavailable");
      }

      if (deletionPayload !== null && typeof deletionPayload === "object") {
        return { ...(deletionPayload as Record<string, unknown>), deletion_status: "deleted" };
      }
      return { id: userId, deleted: true, deletion_status: "deleted" };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Optional(t.Object({ should_soft_delete: t.Optional(t.Boolean()) })),
      detail: { tags: ["auth"], summary: "Delete user" },
    }
  )

  .get(
    "/users/:id/factors",
    async ({ params, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/users/${params.id}/factors`, {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        }
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to list factors");
      }

      return res.json();
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["auth"], summary: "List user MFA factors" },
    }
  )

  .post(
    "/generate_link",
    async ({ params, body, set, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await getGoTrueAdminContext(params.ref);
      if (!ctx) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      const { apiUrl, serviceRoleKey } = ctx;

      const res = await gotrueFetch(`${apiUrl}/admin/generate_link`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "x-project-ref": params.ref
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        set.status = res.status;
        return readGoTrueError(res, "Failed to generate link");
      }

      return res.json();
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        type: t.String(),
        email: t.Optional(t.String()),
        password: t.Optional(t.String()),
        new_email: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        new_phone: t.Optional(t.String()),
        redirect_to: t.Optional(t.String()),
        data: t.Optional(t.Record(t.String(), t.Unknown())),
        gotrue_meta_security: t.Optional(t.Record(t.String(), t.Unknown())),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "Generate auth link" },
    }
  );
