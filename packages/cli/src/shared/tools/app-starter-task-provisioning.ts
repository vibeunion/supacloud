import { STARTER_TASK_SCHEMA } from "./app-starter-tasks";

/** Keep migration 005 bound to the same scoped roles provisioned by migration 004. */
export function renderStarterTaskRecoverySchema(httpRole: string, workerRole: string): string {
  if (httpRole === workerRole || [httpRole, workerRole].some(role => !/^[a-z_][a-z0-9_]{0,62}$/.test(role))) {
    throw new Error("Distinct PostgreSQL runtime role names required");
  }
  // One pass avoids rewriting a role name that itself contains a default name.
  return STARTER_TASK_SCHEMA.replace(/\bstarter_review_(?:http|worker)\b/g,
    role => role === "starter_review_http" ? httpRole : workerRole);
}
