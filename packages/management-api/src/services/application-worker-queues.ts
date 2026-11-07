import { workerShardCount, type WorkerExecutionGroup } from "@supacloud/delivery";
import { getProjectDb, resolveDbName } from "../db";
import { executeSqlStatements } from "../db/sql-statements";
import { renderQueueGrants } from "./pgflow-roles";
import { pgmqService } from "./pgmq.service";

/** Provision every physical queue before a worker activation starts. */
export async function provisionApplicationWorkerQueues(
  projectRef: string,
  groups: readonly WorkerExecutionGroup[],
): Promise<void> {
  for (const group of groups) {
    await pgmqService.createQueueShards(projectRef, group.queue, workerShardCount(group));
  }
  const database = getProjectDb(await resolveDbName(projectRef));
  await executeSqlStatements(database, renderQueueGrants(projectRef).replace(/^\\set ON_ERROR_STOP on\s*/, ""));
}
