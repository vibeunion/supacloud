import { resolvePgrstChannel, type getProjectDb } from "../db";
import { logger } from "../utils/logger";

type ProjectSql = ReturnType<typeof getProjectDb>;
type ReservedProjectSql = Awaited<ReturnType<ProjectSql["reserve"]>>;

export async function notifyPostgrestSchemaReload(
  dbInstance: ProjectSql | ReservedProjectSql,
  projectRef: string,
): Promise<void> {
  const channel = resolvePgrstChannel(projectRef);
  await dbInstance`
    SELECT pg_notify(${channel}, 'reload schema'), pg_notify('pgrst', 'reload schema')
  `;
}

export async function tryNotifyPostgrestSchemaReload(
  dbInstance: ProjectSql | ReservedProjectSql,
  projectRef: string,
): Promise<boolean> {
  try {
    await notifyPostgrestSchemaReload(dbInstance, projectRef);
    return true;
  } catch (error: unknown) {
    logger.warn(`[database] failed to send schema reload notification for ${projectRef}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
