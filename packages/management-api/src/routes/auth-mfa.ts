/**
 * MFA Factor Management API
 * 
 * P0-4: Admin management of user MFA factors
 * Required by Studio Auth > MFA page
 */
import { Elysia, t, status } from "elysia";
import { getProjectDb } from "../db";
import { sql as metaSql } from "../db";
import { logger } from "../utils/logger";

export const authMfaRoutes = new Elysia({ prefix: "/v1/projects" })

  // List all MFA factors (optionally filtered by user_id)
  .get(
    "/:ref/auth/factors",
    async ({ params, query }) => {
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);

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
      }, { additionalProperties: true })
    }
  )

  // Delete a specific MFA factor (admin action)
  .delete(
    "/:ref/auth/factors/:id",
    async ({ params }) => {
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);

        // Also clean up associated challenges
        await db`DELETE FROM auth.mfa_challenges WHERE factor_id = ${params.id}::uuid`;
        const result = await db`DELETE FROM auth.mfa_factors WHERE id = ${params.id}::uuid RETURNING id`;

        if (result.length === 0) return status(404, { error: "MFA factor not found" });
        return { success: true, id: params.id };
      } catch (err: unknown) {
        return status(500, { error: "Failed to delete MFA factor", message: err instanceof Error ? err.message : String(err) });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }) }
  );
