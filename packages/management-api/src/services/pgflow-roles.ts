import { createHash } from "node:crypto";
import { PGFLOW_ROLE_SQL } from "../db/pgflow-role-bundle";

export function roleNames(projectRef: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(projectRef)) throw new Error("PGFLOW_PROJECT_INVALID");
  const key = createHash("sha256").update(projectRef).digest("hex").slice(0, 20);
  return { owner: `scw_owner_${key}`, worker: `scw_worker_${key}`, recovery: `scw_recovery_${key}` };
}

function renderRoleSql(template: string, projectRef: string): string {
  const { owner, worker, recovery } = roleNames(projectRef);
  return template
    .replaceAll("__SCW_OWNER__", owner)
    .replaceAll("__SCW_WORKER__", worker)
    .replaceAll("__SCW_RECOVERY__", recovery)
    .replaceAll("__SCW_PROJECT__", projectRef);
}

export function renderRoles(projectRef: string): string {
  return renderRoleSql(PGFLOW_ROLE_SQL.roles, projectRef);
}

export function renderQueueGrants(projectRef: string): string {
  return renderRoleSql(PGFLOW_ROLE_SQL.queues, projectRef);
}
