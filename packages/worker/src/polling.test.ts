import { describe, expect, test } from "bun:test";
import { adaptivePollInterval } from "./polling.js";
import { ReadWithPollPoller } from "../node_modules/@pgflow/edge-worker/dist/queue/ReadWithPollPoller.js";
import { StepTaskPoller } from "../node_modules/@pgflow/edge-worker/dist/flow/StepTaskPoller.js";
import type { Logger } from "../node_modules/@pgflow/edge-worker/dist/platform/types.js";

const logger: Logger = {
  debug() {}, verbose() {}, info() {}, warn() {}, error() {}, polling() {}, taskCount() {},
  taskStarted() {}, taskCompleted() {}, taskFailed() {}, startupBanner() {}, shutdown() {},
};

describe("adaptive worker polling", () => {
  test("backs off on empty polls and resets immediately when work arrives", () => {
    const interval = adaptivePollInterval({ minIntervalMs: 20, maxIntervalMs: 100, idleBackoffFactor: 2 });
    expect(interval()).toBe(20);
    expect(interval(0)).toBe(40);
    expect(interval()).toBe(40);
    expect(interval(0)).toBe(80);
    expect(interval(0)).toBe(100);
    expect(interval(0)).toBe(100);
    expect(interval(2)).toBe(20);
    expect(interval()).toBe(20);
  });

  test("rejects unsafe polling bounds", () => {
    expect(() => adaptivePollInterval({ minIntervalMs: 0 })).toThrow("WORKER_POLLING_INVALID");
    expect(() => adaptivePollInterval({ minIntervalMs: 100, maxIntervalMs: 10 })).toThrow("WORKER_POLLING_INVALID");
    expect(() => adaptivePollInterval({ idleBackoffFactor: 5 })).toThrow("WORKER_POLLING_INVALID");
  });

  test("passes the adaptive interval into the patched pgflow queue poller", async () => {
    const intervals: number[] = [];
    let reads = 0;
    const queue = {
      queueName: "scw_test",
      async readWithPoll(_batchSize: number, _visibility: number, _maxPoll: number, pollInterval: number) {
        intervals.push(pollInterval);
        reads++;
        return reads === 1 ? [] : [{ msg_id: 1, read_ct: 1, enqueued_at: "2026-01-01", vt: "2026-01-01", message: {} }];
      },
    };
    const interval = adaptivePollInterval({ minIntervalMs: 20, maxIntervalMs: 100, idleBackoffFactor: 2 });
    const poller = new ReadWithPollPoller(
      queue as unknown as ConstructorParameters<typeof ReadWithPollPoller>[0],
      new AbortController().signal, {
      batchSize: 1, maxPollSeconds: 2, pollIntervalMs: interval, visibilityTimeout: 30,
      }, logger,
    );
    await poller.poll();
    await poller.poll();
    expect(intervals).toEqual([20, 40]);
  });

  test("passes the adaptive interval into the patched pgflow Flow poller", async () => {
    const intervals: number[] = [];
    let reads = 0;
    const adapter = {
      async readMessages(_queue: string, _visibility: number, _batch: number, _maxPoll: number, interval: number) {
        intervals.push(interval);
        reads++;
        return reads === 1 ? [] : [{ msg_id: 1, read_ct: 1, enqueued_at: "2026-01-01", vt: "2026-01-01", message: {} }];
      },
      async startTasks() { return []; },
    };
    const interval = adaptivePollInterval({ minIntervalMs: 20, maxIntervalMs: 100, idleBackoffFactor: 2 });
    const poller = new StepTaskPoller(
      adapter as unknown as ConstructorParameters<typeof StepTaskPoller>[0],
      new AbortController().signal,
      { batchSize: 1, queueName: "scw_test", maxPollSeconds: 2, pollIntervalMs: interval, visibilityTimeout: 30 },
      () => "worker", logger,
    );
    await poller.poll();
    await poller.poll();
    expect(intervals).toEqual([20, 40]);
  });
});
