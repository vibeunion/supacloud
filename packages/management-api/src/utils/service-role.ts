export async function resolveProjectServiceRoleKey(project: {
  service_role_key?: string | null;
  jwt_secret?: string | null;
}): Promise<string | null> {
  if (project.service_role_key) {
    return project.service_role_key;
  }

  if (!project.jwt_secret) {
    return null;
  }

  const { jwtService } = await import("../services/jwt.service");
  return jwtService.generateServiceRoleKey(project.jwt_secret);
}
