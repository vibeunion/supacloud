import { workerShardCount, type WorkerExecutionGroup } from "@supacloud/delivery";
import { pgmqService } from "./pgmq.service";

/** Provision every physical queue before a worker activation starts. */
export async function provisionApplicationWorkerQueues(
  projectRef: string,
  groups: readonly WorkerExecutionGroup[],
): Promise<void> {
  for (const group of groups) {
    await pgmqService.createQueueShards(projectRef, group.queue, workerShardCount(group));
  }
}
