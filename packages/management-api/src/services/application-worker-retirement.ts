import type { WorkerExecutionGroup } from "@supacloud/delivery";
import { getProjectDb, resolveDbName } from "../db";
import type { ApplicationDeploymentDependencies } from "./application-deployment";

interface WorkerRetirementQuery {
  query(text: string, parameters: readonly string[]): Promise<unknown>;
}
export type WorkerRetirementTransaction = (
  projectRef: string, verify: (transaction: WorkerRetirementQuery) => Promise<void>,
) => Promise<void>;

const projectTransaction: WorkerRetirementTransaction = async (projectRef, verify) => {
  const database = getProjectDb(await resolveDbName(projectRef));
  await database.begin(async connection => {
    await verify({ query: async (text, parameters) => connection.unsafe(text, [...parameters]) });
  });
};
const zero = (value: unknown) => value === 0 || value === "0" || value === 0n;

/** Read-only evidence: operators must pause admission explicitly before retirement. */
async function requireDrained(
  transaction: WorkerRetirementQuery, projectRef: string, groups: readonly WorkerExecutionGroup[],
): Promise<void> {
  for (const group of groups) {
    const rows = await transaction.query(`SELECT l.accepting,l.outstanding,
      (SELECT count(*)::integer FROM supacloud_worker.admission_tokens t
        WHERE t.group_name=l.group_name AND NOT t.released) AS held,
      (SELECT queue_length FROM pgmq.metrics($3)) AS queued
      FROM supacloud_worker.admission_limits l
      WHERE l.group_name=$2 AND EXISTS (
        SELECT FROM supacloud_worker.installation WHERE singleton AND project_ref=$1
      ) FOR UPDATE OF l`, [projectRef, group.name, group.queue]);
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object"
      || rows[0].accepting !== false || !zero(rows[0].outstanding)
      || !zero(rows[0].held) || !zero(rows[0].queued)) {
      throw new Error("WORKER_GROUP_NOT_DRAINED");
    }
  }
}

/** The default platform composition uses these same checks for both retirement paths. */
export function createApplicationWorkerRetirementChecks(
  transaction: WorkerRetirementTransaction = projectTransaction,
): Required<Pick<ApplicationDeploymentDependencies, "verifyWorkerRetirement" | "verifyWorkerAllocationRetirement">> {
  const verify = async (projectRef: string, groups: readonly WorkerExecutionGroup[]) => {
    if (groups.length) await transaction(projectRef, connection => requireDrained(connection, projectRef, groups));
  };
  return {
    verifyWorkerRetirement: ({ previous, groups }) => verify(previous.runtime.release.project_ref, groups),
    verifyWorkerAllocationRetirement: ({ runtime, groups }) => verify(runtime.release.project_ref, groups),
  };
}
