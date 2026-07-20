import { Elysia, status, t } from "elysia";
import { getProjectDb, resolveDbName } from "../db";
import { projectService } from "../services";
import { logger } from "../utils/logger";
import { resolveTenantPorts } from "../utils/project-routing";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { requireAuthRuntimeManagement } from "./auth-runtime";

const GOTRUE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PAGE_SIZE);

type TotpFactor = {
  id: string;
  user_id: string;
  user_email: string | null;
  friendly_name: string | null;
  factor_type: "totp";
  status: "unverified" | "verified";
  created_at: string;
  updated_at: string;
  enrolled_factor_count: number;
  verified_factor_count: number;
  latest_session_aal: string | null;
  latest_session_updated_at: string | null;
};

type TotpFactorPageRow = {
  items: TotpFactor[];
  total: number | string;
};

function parsePositiveInteger(rawValue: string | undefined, fallback: number, maximum: number): number | null {
  if (rawValue === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(rawValue)) return null;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function databaseErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String((error as { code?: unknown }).code ?? "");
}

function mfaStorageError(error: unknown) {
  logger.warn("[auth-mfa] GoTrue MFA metadata query failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  if (["3F000", "42P01", "42703"].includes(databaseErrorCode(error))) {
    return status(501, {
      code: "CAPABILITY_UNAVAILABLE",
      message: "GoTrue MFA metadata is unavailable",
      reason_code: "gotrue_mfa_schema_unavailable",
    });
  }
  return status(503, {
    code: "SERVICE_UNAVAILABLE",
    message: "GoTrue MFA metadata is temporarily unavailable",
    reason_code: "gotrue_mfa_store_unavailable",
  });
}

async function listTotpFactors(ref: string, userId: string | null, page: number, limit: number) {
  const projectDb = getProjectDb(await resolveDbName(ref));
  const offset = (page - 1) * limit;
  const rows = await projectDb`
    WITH filtered_factors AS (
      SELECT
        factor.id::text,
        factor.user_id::text,
        users.email AS user_email,
        factor.friendly_name,
        factor.factor_type::text AS factor_type,
        factor.status::text AS status,
        factor.created_at,
        factor.updated_at,
        factor_counts.enrolled_factor_count,
        factor_counts.verified_factor_count,
        latest_session.aal AS latest_session_aal,
        latest_session.updated_at AS latest_session_updated_at
      FROM auth.mfa_factors AS factor
      LEFT JOIN auth.users AS users ON users.id = factor.user_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS enrolled_factor_count,
          COUNT(*) FILTER (WHERE user_factor.status::text = 'verified')::int AS verified_factor_count
        FROM auth.mfa_factors AS user_factor
        WHERE user_factor.user_id = factor.user_id
      ) AS factor_counts ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(session.aal::text, 'aal1') AS aal,
          session.updated_at
        FROM auth.sessions AS session
        WHERE session.user_id = factor.user_id
        ORDER BY COALESCE(session.refreshed_at, session.updated_at, session.created_at) DESC, session.id DESC
        LIMIT 1
      ) AS latest_session ON TRUE
      WHERE factor.factor_type::text = 'totp'
        AND (${userId}::text IS NULL OR factor.user_id = ${userId}::uuid)
    ), page_items AS (
      SELECT *
      FROM filtered_factors
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    )
    SELECT
      COALESCE(jsonb_agg(page_items ORDER BY page_items.created_at DESC, page_items.id DESC), '[]'::jsonb) AS items,
      (SELECT COUNT(*)::int FROM filtered_factors) AS total
    FROM page_items
  ` as TotpFactorPageRow[];
  const factorPage = rows[0];
  return {
    items: Array.isArray(factorPage?.items) ? factorPage.items : [],
    total: Number(factorPage?.total ?? 0),
    page,
    limit,
  };
}

async function findTotpFactorOwner(ref: string, factorId: string): Promise<string | null> {
  const projectDb = getProjectDb(await resolveDbName(ref));
  const rows = await projectDb`
    SELECT factor.user_id::text AS user_id
    FROM auth.mfa_factors AS factor
    WHERE factor.id = ${factorId}::uuid
      AND factor.factor_type::text = 'totp'
    LIMIT 1
  ` as Array<{ user_id: string }>;
  return rows[0]?.user_id ?? null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const field = record[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

async function goTrueError(response: Response, fallbackMessage: string) {
  const responseText = await response.text();
  let payload: Record<string, unknown> = {};
  if (responseText.trim()) {
    try {
      const parsed = JSON.parse(responseText) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return {
    code: readString(payload, "error_code") ?? readString(payload, "code") ?? String(response.status),
    message:
      readString(payload, "msg") ??
      readString(payload, "message") ??
      (responseText.trim() || fallbackMessage),
  };
}

export const authMfaRoutes = new Elysia({ prefix: "/v1/projects" })
  .onBeforeHandle(requireAuthRuntimeManagement("mfa"))
  .get(
    "/:ref/auth/factors",
    async ({ params, query }) => {
      const page = parsePositiveInteger(query.page, 1, MAX_PAGE);
      const limit = parsePositiveInteger(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      if (page === null || limit === null) {
        return status(400, {
          code: "VALIDATION_ERROR",
          message: `page must be a positive integer and limit must be between 1 and ${MAX_PAGE_SIZE}`,
        });
      }
      if (query.user_id && !GOTRUE_UUID_PATTERN.test(query.user_id)) {
        return status(400, { code: "VALIDATION_ERROR", message: "GoTrue user id must be a UUID" });
      }

      let project;
      try {
        project = await projectService.getProject(params.ref);
      } catch (error) {
        logger.warn("[auth-mfa] Failed to read project metadata", {
          error: error instanceof Error ? error.message : String(error),
        });
        return status(503, {
          code: "SERVICE_UNAVAILABLE",
          message: "Project metadata is temporarily unavailable",
          reason_code: "project_metadata_unavailable",
        });
      }
      if (!project) return status(404, { code: "NOT_FOUND", message: "Project not found" });

      try {
        return await listTotpFactors(params.ref, query.user_id ?? null, page, limit);
      } catch (error) {
        return mfaStorageError(error);
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object({
        user_id: t.Optional(t.String()),
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ["auth"], summary: "List GoTrue TOTP factors" },
    },
  )
  .post(
    "/:ref/auth/factors",
    () => status(501, {
      code: "CAPABILITY_UNAVAILABLE",
      message: "TOTP enrollment must be completed by the signed-in user through GoTrue",
      reason_code: "gotrue_user_mfa_ceremony_required",
    }),
    {
      params: t.Object({ ref: t.String() }),
      detail: { hide: true },
    },
  )
  .delete(
    "/:ref/auth/factors/:id",
    async ({ params, set }) => {
      if (!GOTRUE_UUID_PATTERN.test(params.id)) {
        return status(400, { code: "VALIDATION_ERROR", message: "GoTrue factor id must be a UUID" });
      }

      let project;
      try {
        project = await projectService.getProject(params.ref);
      } catch (error) {
        logger.warn("[auth-mfa] Failed to read project metadata for factor deletion", {
          error: error instanceof Error ? error.message : String(error),
        });
        return status(503, {
          code: "SERVICE_UNAVAILABLE",
          message: "Project metadata is temporarily unavailable",
          reason_code: "project_metadata_unavailable",
        });
      }
      if (!project) return status(404, { code: "NOT_FOUND", message: "Project not found" });

      let factorOwnerId: string | null;
      try {
        factorOwnerId = await findTotpFactorOwner(params.ref, params.id);
      } catch (error) {
        return mfaStorageError(error);
      }
      if (!factorOwnerId) return status(404, { code: "NOT_FOUND", message: "TOTP factor not found" });

      const ports = resolveTenantPorts(project.config);
      let serviceRoleKey: string | null;
      try {
        serviceRoleKey = await resolveProjectServiceRoleKey(params.ref);
      } catch (error) {
        logger.warn("[auth-mfa] Failed to resolve GoTrue admin credentials", {
          error: error instanceof Error ? error.message : String(error),
        });
        serviceRoleKey = null;
      }
      if (!serviceRoleKey || !ports?.gotruePort) {
        return status(503, {
          code: "SERVICE_UNAVAILABLE",
          message: "GoTrue admin endpoint is unavailable",
          reason_code: "gotrue_admin_unavailable",
        });
      }

      let response: Response;
      try {
        response = await fetch(
          `http://127.0.0.1:${ports.gotruePort}/admin/users/${factorOwnerId}/factors/${params.id}`,
          {
            method: "DELETE",
            headers: {
              apikey: serviceRoleKey,
              Authorization: `Bearer ${serviceRoleKey}`,
              "x-project-ref": params.ref,
            },
          },
        );
      } catch (error) {
        logger.warn("[auth-mfa] GoTrue factor deletion request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return status(503, {
          code: "SERVICE_UNAVAILABLE",
          message: "GoTrue MFA service is temporarily unavailable",
          reason_code: "gotrue_mfa_unavailable",
        });
      }

      if (!response.ok) {
        try {
          const errorPayload = await goTrueError(response, "Failed to delete TOTP factor");
          set.status = response.status;
          return errorPayload;
        } catch (error) {
          logger.warn("[auth-mfa] Failed to read GoTrue factor deletion response", {
            error: error instanceof Error ? error.message : String(error),
          });
          return status(503, {
            code: "SERVICE_UNAVAILABLE",
            message: "GoTrue MFA service returned an unreadable response",
            reason_code: "gotrue_mfa_unavailable",
          });
        }
      }
      return { success: true, id: params.id, source: "gotrue" };
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      detail: { tags: ["auth"], summary: "Delete a GoTrue TOTP factor" },
    },
  );
