export class ProjectStateTransitionLockedError extends Error {
  readonly code = "project_state_locked" as const;

  constructor(readonly projectRef: string) {
    super(`Another database operation is already running for ${projectRef}`);
    this.name = "ProjectStateTransitionLockedError";
  }
}

export function projectDatabaseLockKey(projectRef: string): string {
  return `supacloud:project-database:${projectRef}`;
}
