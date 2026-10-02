import { describe, expect, test } from "bun:test";
import {
  createApplicationEventStream,
  EventStreamClosedError,
  EventStreamOverflowError,
} from "./event_stream";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("application event stream", () => {
  test("serializes async consumers and keeps failures isolated", async () => {
    const stream = createApplicationEventStream<number>({ maxQueue: 8 });
    const seen: number[] = [];
    const failures: unknown[] = [];
    const subscription = stream.subscribe(async value => {
      seen.push(value);
      if (value === 2) throw new Error("consumer failed");
      await Promise.resolve();
    }, { onError: error => failures.push(error) });

    await stream.publish(1);
    await stream.publish(2);
    await stream.publish(3);
    await tick();
    expect(seen).toEqual([1, 2, 3]);
    expect(failures).toHaveLength(1);
    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
    await stream.close();
  });

  test("applies bounded queue overflow and supports drop-oldest", async () => {
    const stream = createApplicationEventStream<number>({ maxQueue: 1, overflow: "error" });
    const gate: { release?: () => void } = {};
    let started = false;
    const first = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    const errors: unknown[] = [];
    const subscription = stream.subscribe(async value => {
      started = true;
      if (value === 1) await first;
    }, { onError: error => errors.push(error) });
    await stream.publish(1);
    expect(started).toBe(true);
    await stream.publish(2);
    await expect(stream.publish(3)).rejects.toBeInstanceOf(EventStreamOverflowError);
    gate.release?.();
    await subscription.completion;
    expect(errors).toHaveLength(1);
    await stream.close();

    const dropped = createApplicationEventStream<number>({ maxQueue: 1, overflow: "drop-oldest" });
    const values: number[] = [];
    const droppedSub = dropped.subscribe(async value => {
      values.push(value);
      if (value === 1) await tick();
    });
    await dropped.publish(1);
    await dropped.publish(2);
    await dropped.publish(3);
    await tick();
    droppedSub.unsubscribe();
    await dropped.close();
    expect(values).toEqual([1, 3]);
  });

  test("aborts consumers, completes close, and rejects later publishing", async () => {
    const stream = createApplicationEventStream<number>();
    const controller = new AbortController();
    const values: number[] = [];
    const subscription = stream.subscribe(value => { values.push(value); }, { signal: controller.signal });
    await stream.publish(1);
    controller.abort();
    await subscription.completion;
    await stream.publish(2);
    expect(values).toEqual([1]);
    await stream.close();
    await expect(stream.publish(3)).rejects.toBeInstanceOf(EventStreamClosedError);
  });
});
