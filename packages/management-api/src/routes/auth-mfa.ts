import { Elysia, t, status } from "elysia";
import { getProjectDb, resolveDbName } from "../db";
import { sql as metaSql } from "../db";
import { logger } from "../utils/logger";
import { projectService } from "../services";
import { resolveTenantPorts } from "../utils/project-routing";
import { resolveProjectServiceRoleKey } from "../utils/service-role";

async function getGotruePort(ref: string): Promise<number | null> {
    try {
        const rows = await metaSql`
          SELECT config
          FROM projects
          WHERE ref = ${ref} AND deleted_at IS NULL
          LIMIT 1
        `;
        const ports = resolveTenantPorts(rows[0]?.config as Record<string, unknown> | undefined);
        if (ports?.gotruePort) return ports.gotruePort;
    } catch {}
    return null;
}

export const authMfaRoutes = new Elysia({ prefix: "/v1/projects" })

  .get(
    "/:ref/auth/factors",
    async ({ params, query }) => {
      const dbName = await resolveDbName(params.ref);
      try {
        const db = getProjectDb(dbName);

        let factors;
        if (query.user_id) {
          factors = await db`
            SELECT f.id, f.user_id, f.friendly_name, f.factor_type, f.status, f.created_at, f.updated_at,
              u.email as user_email
            FROM auth.mfa_factors f
            LEFT JOIN auth.users u ON u.id = f.user_id
            WHERE f.user_id = ${query.user_id}::uuid
            ORDER BY f.created_at DESC
          `;
        } else {
          factors = await db`
            SELECT f.id, f.user_id, f.friendly_name, f.factor_type, f.status, f.created_at, f.updated_at,
              u.email as user_email
            FROM auth.mfa_factors f
            LEFT JOIN auth.users u ON u.id = f.user_id
            ORDER BY f.created_at DESC
            LIMIT 100
          `;
        }

        return factors;
      } catch (err) {
        logger.warn("[auth-mfa] Failed to list MFA factors — table may not exist yet", { error: err });
        return [];
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      query: t.Object({
        user_id: t.Optional(t.String()),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "List MFA factors" },
    }
  )

  .post(
    "/:ref/auth/factors",
    async ({ params, body, set }) => {
      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }

      const serviceRoleKey = await resolveProjectServiceRoleKey(params.ref);
      if (!serviceRoleKey) {
        return status(404, { message: "Project service role key not found", code: "404" });
      }
      let apiUrl: string;
      const gotruePort = await getGotruePort(params.ref);
      if (gotruePort) {
        apiUrl = `http://127.0.0.1:${gotruePort}`;
      } else {
        return status(503, { message: "GoTrue admin endpoint unavailable", code: "503" });
      }

      try {
        const res = await fetch(`${apiUrl}/admin/factors`, {
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
          const err = await res.json().catch(() => ({}));
          return { message: err.msg || err.message || "Failed to enroll factor", code: err.code || "500" };
        }

        return res.json();
      } catch (err: unknown) {
        return status(500, { message: "Failed to enroll factor" });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        user_id: t.String(),
        friendly_name: t.Optional(t.String()),
        factor_type: t.String(),
        secret: t.Optional(t.String()),
      }, { additionalProperties: true }),
      detail: { tags: ["auth"], summary: "Enroll MFA factor" },
    }
  )

  .delete(
    "/:ref/auth/factors/:id",
    async ({ params }) => {
      const [project] = await metaSql`SELECT service_role_key FROM projects WHERE ref=${params.ref}`;
      const dbName = await resolveDbName(params.ref);

      const gotruePort = await getGotruePort(params.ref);
      if (gotruePort) {
          try {
              const res = await fetch(`http://127.0.0.1:${gotruePort}/admin/factors/${params.id}`, {
                  method: 'DELETE',
                  headers: {
                      'apikey': project?.service_role_key,
                      'Authorization': `Bearer ${project?.service_role_key}`,
                      'Content-Type': 'application/json'
                  }
              });
              if (res.ok) {
                  const data = await res.json().catch(() => ({}));
                  return { success: true, id: params.id, ...data };
              }
              if (res.status === 404) return status(404, { message: "MFA factor not found", code: "404" });
              logger.warn(`[auth-mfa] GoTrue DELETE /admin/factors returned ${res.status}, falling back to direct DB`);
          } catch (err) {
              logger.warn(`[auth-mfa] GoTrue API unavailable, falling back to direct DB: ${err}`);
          }
      }

      try {
        const db = getProjectDb(dbName);
        await db`DELETE FROM auth.mfa_challenges WHERE factor_id = ${params.id}::uuid`;
        const result = await db`DELETE FROM auth.mfa_factors WHERE id = ${params.id}::uuid RETURNING id`;
        if (result.length === 0) return status(404, { message: "MFA factor not found", code: "404" });
        return { success: true, id: params.id };
      } catch (err: unknown) {
        return status(500, { message: "Failed to delete MFA factor", code: "500" });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }), detail: { tags: ["auth"], summary: "Delete MFA factor" } }
  );
