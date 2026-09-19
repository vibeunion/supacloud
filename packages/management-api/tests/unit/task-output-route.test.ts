import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { createTaskOutputRoutes } from "../../src/routes/task-output-route-factory";
import { taskOutputResponse } from "../../src/routes/task-output-handler";
const id = "11111111-1111-1111-1111-111111111111";
function createApp() {
  return new Elysia().use(new Elysia().get("/unrelated", () => ({ original: true }))).use(createTaskOutputRoutes({
    authorizeRead: async (request) => request.headers.get("authorization") === "Bearer user"
      ? { invokerUserId: id } : taskOutputResponse({ code: "unauthorized" }, 401),
    authorizeWrite: async (request) => request.headers.get("authorization") === "Bearer executor"
      ? null : taskOutputResponse({ code: "denied" }, 403),
    read: async (_ref, _task, _after, _limit, owner) => ({ owner, events: [] }),
    append: async (_ref, _task, input) => ({ ...input, sequence: "1" }),
  }));
}
test("Elysia authorizes before parsing a malformed POST", async () => {
  const response = await createApp().handle(new Request(`http://localhost/v1/projects/demo/tasks/${id}/events`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not-json",
  }));
  expect(response.status).toBe(403);
});
test("Elysia passes the raw authorized body to the bounded reader", async () => {
  const response = await createApp().handle(new Request(`http://localhost/v1/projects/demo/tasks/${id}/events`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer executor" },
    body: JSON.stringify({ attempt: 1, event_id: id, type: "output.delta", payload: { text: "hello" } }),
  }));
  expect(response.status).toBe(200); expect((await response.json()).sequence).toBe("1");
});
test("read authorization stays on the new resource and does not change unrelated routes", async () => {
  const app = createApp();
  const response = await app.handle(new Request(`http://localhost/v1/projects/demo/tasks/${id}/events`, { headers: { authorization: "Bearer user" } }));
  expect(response.status).toBe(200); expect((await response.json()).owner).toBe(id);
  const ordinary = await app.handle(new Request("http://localhost/unrelated"));
  expect(await ordinary.json()).toEqual({ original: true });
});
