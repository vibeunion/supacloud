export async function resolveProjectServiceRoleKey(projectOrRef: string | {
  ref?: string | null;
  service_role_key?: string | null;
  jwt_secret?: string | null;
}): Promise<string | null> {
  const project = typeof projectOrRef === "string"
    ? await loadProjectSecrets(projectOrRef)
    : projectOrRef;

  if (project?.service_role_key) {
    return project.service_role_key;
  }

  if (!project?.jwt_secret) {
    return null;
  }

  const { jwtService } = await import("../services/jwt.service");
  return jwtService.generateServiceRoleKey(project.jwt_secret);
}

async function loadProjectSecrets(ref: string): Promise<{
  service_role_key?: string | null;
  jwt_secret?: string | null;
} | null> {
  const { sql } = await import("../db");
  const rows = await sql`
    SELECT service_role_key, jwt_secret
    FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}
