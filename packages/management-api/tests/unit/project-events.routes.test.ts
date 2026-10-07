import { Elysia } from "elysia";
import { expect, test } from "bun:test";
import { createProjectEventRoutes } from "../../src/routes/project-events";

test("project event route validates pagination and forwards the cursor", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const app = new Elysia().use(createProjectEventRoutes({
    authorize: async () => undefined,
    list: async input => {
      calls.push(input);
      return { events: [], next_cursor: null };
    },
  }));
  const invalid = await app.handle(new Request("http://localhost/v1/projects/demo/events?limit=201"));
  expect(invalid.status).toBe(400);
  const valid = await app.handle(new Request("http://localhost/v1/projects/demo/events?kind=workflow&limit=2&cursor=abc"));
  expect(valid.status).toBe(200);
  expect(calls).toEqual([{
    projectRef: "demo", kind: "workflow", status: undefined, limit: 2, cursor: "abc",
  }]);
});

test("project event route preserves the existing authorization boundary", async () => {
  const app = new Elysia().use(createProjectEventRoutes({
    authorize: async () => ({ status: 403, body: { error: "Access denied" } }),
  }));
  const response = await app.handle(new Request("http://localhost/v1/projects/demo/events"));
  expect(response.status).toBe(403);
});
