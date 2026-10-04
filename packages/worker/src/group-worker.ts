import { parseWorkerExecutionGroup, type WorkerExecutionGroup } from "@supacloud/delivery/worker-execution";
import { createPgflowQueueWorker } from "./index.js";
import { executionQueueOptions, workerExecutionFromEnvironment } from "./execution-group.js";
import type { TaskHandler } from "./queue-handler.js";

export interface WorkerHealth {
  ready: boolean;
  active: number;
  completed: number;
  failed: number;
  timedOut: number;
  executionBuckets: number[];
  queueWaitBuckets: number[];
  rssBytes: number;
}

/** Trusted application code; the bounded pool/probe belongs to the domain adapter. */
export interface ExecutionGroupDomain<T> extends TaskHandler<T> {
  /** Must verify project/database identity, queue, grants and configured pool size. */
  preflight(group: WorkerExecutionGroup, projectRef: string): Promise<void>;
  probe(signal: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}

export function createExecutionGroupWorker<T>(options: {
  projectRef: string;
  connectionString: string;
  group?: WorkerExecutionGroup;
}, domain: ExecutionGroupDomain<T>) {
  const execution = parseWorkerExecutionGroup(options.group ?? workerExecutionFromEnvironment());
  const bounds = [10, 50, 100, 500, 1000, 5000, 30000, Infinity];
  const metrics: WorkerHealth = {
    ready: false, active: 0, completed: 0, failed: 0, timedOut: 0,
    executionBuckets: bounds.map(() => 0), queueWaitBuckets: bounds.map(() => 0), rssBytes: 0,
  };
  let started = false;
  let closing: Promise<void> | undefined;
  let rejectFailure: (error: Error) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  // Observe immediately; the delivery host also consumes the fatal channel.
  void failure.catch(() => {});
  const worker = createPgflowQueueWorker({
    projectRef: options.projectRef, connectionString: options.connectionString, ...executionQueueOptions(execution),
    async supervise(run, upstreamSignal, enqueuedAt) {
      metrics.active++;
      const began = performance.now();
      if (enqueuedAt !== null) metrics.queueWaitBuckets[bounds.findIndex(bound => Math.max(0, Date.now() - enqueuedAt) <= bound)]!++;
      const controller = new AbortController();
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true; metrics.timedOut++; metrics.ready = false;
        controller.abort();
        // Do not race/return the handler: that could ACK or retry while it still runs.
        // The delivery supervisor ends the process; the queue lease remains authoritative.
        rejectFailure(new Error("WORKER_EXECUTION_DEADLINE"));
      }, execution.lifecycle.executionTimeoutSeconds * 1000);
      try {
        await run(AbortSignal.any([upstreamSignal, controller.signal]));
        if (expired) {
          const error = new Error("WORKER_EXECUTION_DEADLINE");
          error.name = "AbortError";
          throw error;
        }
        metrics.completed++;
      } catch (error) {
        metrics.failed++;
        throw error;
      } finally {
        clearTimeout(timeout);
        metrics.active--;
        metrics.executionBuckets[bounds.findIndex(bound => performance.now() - began <= bound)]!++;
      }
    },
  }, {
    decode: domain.decode,
    authorize: (input, context) => domain.authorize(input, context),
    execute: (input, context) => domain.execute(input, context),
  });
  return {
    execution,
    failure,
    async start() {
      if (started || closing) throw new Error("WORKER_RESTART_REQUIRES_NEW_PROCESS");
      started = true;
      await domain.preflight(execution, options.projectRef);
      process.env.WORKER_NAME = execution.name;
      await worker.start();
      metrics.ready = true;
    },
    async health(): Promise<WorkerHealth> {
      let available = false;
      try { available = await domain.probe(AbortSignal.timeout(2000)); } catch { /* Bounded health only. */ }
      return {
        ...metrics, executionBuckets: [...metrics.executionBuckets], queueWaitBuckets: [...metrics.queueWaitBuckets],
        rssBytes: process.memoryUsage().rss, ready: metrics.ready && available && worker.state === "running",
      };
    },
    close() {
      metrics.ready = false;
      return closing ??= (async () => {
        try { await worker.stop(); } finally { await domain.close(); }
      })();
    },
  };
}
