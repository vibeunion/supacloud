import { expect, test } from "bun:test";
import { renderDeliveryHttpEntry } from "./delivery-http";
import { renderDeliveryWorkerEntry } from "./delivery-worker";
import { parseDeliveryOptions } from "./delivery-schema";

const host = "/project/src/delivery-host.ts";

test("delivery options opt into generated database injection per host", () => {
  const options = parseDeliveryOptions({
    version: 1,
    build: {
      httpApplications: [{ target: "api", source: "delivery-host.ts", database: true }],
      workerApplications: [{ target: "jobs", source: "delivery-worker.ts", database: true }],
    },
  });
  expect(options.build?.httpApplications?.[0]?.database).toBe(true);
  expect(options.build?.workerApplications?.[0]?.database).toBe(true);
});

test("HTTP delivery wrapper injects and closes a host-owned database client", () => {
  const source = renderDeliveryHttpEntry("/project/generated", host, true);
  expect(source).toContain('from "@supacloud/db/bun"');
  expect(source).toContain("createDeliveryDatabase");
  expect(source).toContain("deps: { dbClient }");
  expect(source).toContain("finally { await closeDatabase(); }");
});

test("worker delivery wrapper keeps the legacy contract without database wiring", () => {
  const source = renderDeliveryWorkerEntry("/project/generated", host);
  expect(source).not.toContain("@supacloud/db/bun");
  expect(source).not.toContain("createDeliveryDatabase");
  expect(source).toContain("{ signal: lifecycle.signal }");
});
