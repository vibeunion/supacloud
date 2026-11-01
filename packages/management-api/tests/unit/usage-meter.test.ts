import { expect, test } from "bun:test";
import {
  assertUsagePayloadRecordsUsageOnly,
  cpuUsageObservation,
  functionUsageObservation,
  storageUsageObservation,
  UsageMeter,
  UsageMeterError,
} from "../../src/services/usage-meter";

const at = "2026-11-01T01:30:00.000Z";

function meterWithUsage(): UsageMeter {
  const meter = new UsageMeter();
  meter.record(cpuUsageObservation({
    projectRef: "demo", cpuMilliseconds: 15, observationId: "cpu-1", observedAt: at, subject: "api",
  }));
  meter.record(storageUsageObservation({
    projectRef: "demo", storageBytes: 100, observationId: "storage-1", observedAt: "2026-11-01T01:15:00.000Z",
  }));
  meter.record(functionUsageObservation({
    projectRef: "demo", invocations: 2, observationId: "fn-1", observedAt: "2026-11-01T01:45:00.000Z", subject: "hello",
  }));
  meter.record(cpuUsageObservation({
    projectRef: "demo", cpuMilliseconds: 5, observationId: "cpu-2", observedAt: "2026-11-01T02:00:00.000Z",
  }));
  meter.record(cpuUsageObservation({
    projectRef: "other", cpuMilliseconds: 9, observationId: "cpu-1", observedAt: at,
  }));
  return meter;
}

test("usage readings sum cpu, storage, and function receipts without a charge", () => {
  const meter = meterWithUsage();
  const replay = meter.record(cpuUsageObservation({
    projectRef: "demo", cpuMilliseconds: 15, observationId: "cpu-1", observedAt: "2026-11-01T01:30:00Z", subject: "api",
  }));
  expect(replay.replayed).toBe(true);

  const reading = meter.reading("demo", "2026-11-01T01:00:00.000Z", "2026-11-01T02:00:00.000Z");
  expect(reading).toEqual({
    schema: "supacloud.usage-reading.v1",
    projectRef: "demo",
    windowStart: "2026-11-01T01:00:00.000Z",
    windowEnd: "2026-11-01T02:00:00.000Z",
    recorded: true,
    charged: false,
    lines: [
      { dimension: "cpu", unit: "cpu_milliseconds", aggregation: "sum", quantity: 15, receiptCount: 1 },
      { dimension: "storage", unit: "storage_bytes", aggregation: "sum", quantity: 100, receiptCount: 1 },
      { dimension: "function", unit: "function_invocations", aggregation: "sum", quantity: 2, receiptCount: 1 },
    ],
  });
  assertUsagePayloadRecordsUsageOnly(reading);
  expect(meter.reading("demo", "2026-11-01T02:00:00.000Z", "2026-11-01T03:00:00.000Z").lines[0]?.quantity).toBe(5);
  expect(meter.reading("other", "2026-11-01T01:00:00.000Z", "2026-11-01T02:00:00.000Z").lines[0]?.quantity).toBe(9);
});

test("hourly counters keep the hour of the observation and ignore an exclusive end", () => {
  const meter = meterWithUsage();
  expect(meter.countersFor("demo", {
    from: "2026-11-01T02:00:00.000Z",
    to: "2026-11-01T03:00:00.000Z",
  })).toEqual([{
    schema: "supacloud.usage-counter.v1",
    projectRef: "demo",
    dimension: "cpu",
    unit: "cpu_milliseconds",
    aggregation: "sum",
    windowStart: "2026-11-01T02:00:00.000Z",
    windowEnd: "2026-11-01T03:00:00.000Z",
    quantity: 5,
    receiptCount: 1,
  }]);
  const firstHour = meter.countersFor("demo", {
    from: "2026-11-01T01:30:00.000Z",
    to: "2026-11-01T01:45:00.000Z",
  });
  expect(firstHour.map(counter => counter.dimension).sort()).toEqual(["cpu", "function", "storage"]);
  expect(firstHour.every(counter => counter.windowStart === "2026-11-01T01:00:00.000Z")).toBe(true);
});

test("a repeated observation with a different quantity keeps the original receipt", () => {
  const meter = meterWithUsage();
  expect(() => meter.record(cpuUsageObservation({
    projectRef: "demo", cpuMilliseconds: 16, observationId: "cpu-1", observedAt: at, subject: "api",
  }))).toThrow(UsageMeterError);
  expect(meter.reading("demo", "2026-11-01T01:00:00.000Z", "2026-11-01T02:00:00.000Z").lines[0]?.quantity).toBe(15);
});

test("recorded receipts drop charge fields and reject empty or fractional quantities", () => {
  const meter = new UsageMeter();
  const recorded = meter.record({
    ...cpuUsageObservation({
      projectRef: "demo", cpuMilliseconds: 4, observationId: "cpu-3", observedAt: at,
    }),
    price: 12,
    invoice: "hidden",
  });
  expect(recorded.receipt).not.toHaveProperty("price");
  expect(JSON.stringify(recorded.receipt)).not.toContain("invoice");
  expect(recorded.receipt.schema).toBe("supacloud.usage-receipt.v1");
  expect(() => meter.record(storageUsageObservation({
    projectRef: "demo", storageBytes: 0, observationId: "storage-0", observedAt: at,
  }))).toThrow(UsageMeterError);
  expect(() => meter.record(functionUsageObservation({
    projectRef: "demo", invocations: 1.5, observationId: "fn-2", observedAt: at,
  }))).toThrow(UsageMeterError);
});

test("counters fail closed before exceeding a safe integer", () => {
  const meter = new UsageMeter();
  meter.record(cpuUsageObservation({
    projectRef: "demo",
    cpuMilliseconds: Number.MAX_SAFE_INTEGER,
    observationId: "cpu-max",
    observedAt: at,
  }));
  expect(() => meter.record(cpuUsageObservation({
    projectRef: "demo", cpuMilliseconds: 1, observationId: "cpu-next", observedAt: at,
  }))).toThrow(UsageMeterError);
  expect(meter.receiptsFor("demo").map(receipt => receipt.observationId)).toEqual(["cpu-max"]);
});

test("usage windows reject an empty, reversed, or year-spanning range", () => {
  const meter = new UsageMeter();
  expect(() => meter.reading("demo", "2026-11-02T00:00:00.000Z", "2026-11-01T00:00:00.000Z")).toThrow(UsageMeterError);
  expect(() => meter.reading("demo", "2026-11-01T00:00:00.000Z", "2027-11-03T00:00:00.000Z")).toThrow(UsageMeterError);
  expect(() => meter.reading("not a ref", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z")).toThrow(UsageMeterError);
});
