import { Elysia } from "elysia";
import { expect, test } from "bun:test";
import { createProjectCapacityRoutes } from "../../src/routes/project-capacity";

test("capacity report remains behind the existing project authorization boundary", async () => {
  const app = new Elysia().use(createProjectCapacityRoutes({
    report: { capacityReport: async projectRef => ({
      schema: "supacloud.application-capacity-report.v1",
      projectRef,
      generatedAt: "2026-10-08T00:00:00.000Z",
      budget: null,
      usage: { cpu: 0, memoryMiB: 0, connections: 0, concurrency: 0, ports: 0 },
      remaining: null,
      pressure: "unknown",
      activeAllocations: 0,
      activePorts: 0,
      projectAllocations: 0,
      projectUsage: { cpu: 0, memoryMiB: 0, connections: 0, concurrency: 0 },
      queueOwners: [],
    }) },
  }));
  const response = await app.handle(new Request("http://localhost/v1/projects/demo/capacity"));
  expect([401, 403]).toContain(response.status);
});
