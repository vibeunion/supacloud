import { Elysia } from "elysia";
import { expect, test } from "bun:test";
import { createProjectUsageRoutes } from "../../src/routes/project-usage";
import {
  cpuUsageObservation,
  UsageMeter,
  type UsageMeterReader,
} from "../../src/services/usage-meter";

function reader(meter: UsageMeter): UsageMeterReader {
  return {
    reading: async (projectRef, windowStart, windowEnd) => meter.reading(projectRef, windowStart, windowEnd),
    receipts: async (projectRef, query) => meter.receiptsFor(projectRef, query),
    counters: async (projectRef, query) => meter.countersFor(projectRef, query),
  };
}

function app(meter = new UsageMeter()) {
  return new Elysia().use(createProjectUsageRoutes({
    meter: reader(meter),
    authorize: async () => undefined,
  }));
}

test("usage routes stay behind the existing project authorization boundary", async () => {
  const closed = new Elysia().use(createProjectUsageRoutes({ meter: reader(new UsageMeter()) }));
  const response = await closed.handle(new Request("http://localhost/v1/projects/demo/usage-meter?from=2026-11-01T00:00:00.000Z&to=2026-11-01T02:00:00.000Z"));
  expect([401, 403]).toContain(response.status);
});

test("usage route returns recorded quantities and no charge", async () => {
  const meter = new UsageMeter();
  meter.record(cpuUsageObservation({
    projectRef: "demo", cpuMilliseconds: 20, observationId: "cpu-1", observedAt: "2026-11-01T01:10:00.000Z",
  }));
  const response = await app(meter).handle(new Request(
    "http://localhost/v1/projects/demo/usage-meter?from=2026-11-01T01:00:00.000Z&to=2026-11-01T02:00:00.000Z",
  ));
  expect(response.status).toBe(200);
  const body = await response.json() as { charged: boolean; recorded: boolean; lines: Array<{ quantity: number }> };
  expect(body.recorded).toBe(true);
  expect(body.charged).toBe(false);
  expect(body.lines.map(line => line.quantity)).toEqual([20, 0, 0]);
  expect(JSON.stringify(body)).not.toMatch(/price|invoice|currency|stripe|payment/i);

  const receipts = await app(meter).handle(new Request("http://localhost/v1/projects/demo/usage-meter/receipts"));
  expect(receipts.status).toBe(200);
  const receiptBody = await receipts.json() as { receipts: Array<{ quantity: number; dimension: string }> };
  expect(receiptBody.receipts).toEqual([expect.objectContaining({ dimension: "cpu", quantity: 20 })]);

  const counters = await app(meter).handle(new Request("http://localhost/v1/projects/demo/usage-meter/counters"));
  expect(counters.status).toBe(200);
  const counterBody = await counters.json() as { counters: Array<{ quantity: number }> };
  expect(counterBody.counters[0]?.quantity).toBe(20);
});

test("usage route rejects a missing window, a bad dimension, and an invalid project ref", async () => {
  const routes = app();
  const missing = await routes.handle(new Request("http://localhost/v1/projects/demo/usage-meter"));
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ code: "USAGE_WINDOW_INVALID" });

  const dimension = await routes.handle(new Request("http://localhost/v1/projects/demo/usage-meter/receipts?dimension=gpu"));
  expect(dimension.status).toBe(400);
  expect(await dimension.json()).toMatchObject({ code: "USAGE_DIMENSION_INVALID" });

  const project = await routes.handle(new Request(
    "http://localhost/v1/projects/abcdefghijklmnopqrstu/usage-meter?from=2026-11-01T00:00:00.000Z&to=2026-11-01T02:00:00.000Z",
  ));
  expect(project.status).toBe(400);
  expect(await project.json()).toMatchObject({ code: "USAGE_PROJECT_INVALID" });
});
