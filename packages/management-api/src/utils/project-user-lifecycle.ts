export const PROJECT_USER_LIFECYCLE_LOCK_NAMESPACE = "project-user-lifecycle";

export const GOTRUE_USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GOTRUE_USER_ID_POSTGRES_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export function normalizedGoTrueUserId(userId: string): string | null {
  const normalized = userId.trim().toLowerCase();
  return GOTRUE_USER_ID_PATTERN.test(normalized) ? normalized : null;
}

export function projectUserLifecycleLockKey(projectRef: string, userId: string): string {
  return `${PROJECT_USER_LIFECYCLE_LOCK_NAMESPACE}:${projectRef}:${userId}`;
}
