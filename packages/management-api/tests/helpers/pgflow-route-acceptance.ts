import { mock, spyOn } from "bun:test";
import { SQL } from "bun";
import assert from "node:assert/strict";
import { Elysia } from "elysia";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "../../../supacloud-js/src/index";

const databaseUrl = process.env.WORKER_TEST_DATABASE_URL;
const runId = process.env.WORKER_TEST_RUN_ID;
if (!databaseUrl || !runId) throw new Error("Missing isolated fixture input");
const db = new SQL(databaseUrl);
let queries = 0;
const modulePath = (path: string) => new URL(path, import.meta.url).pathname;
mock.module(modulePath("../../src/db/index.ts"), () => ({
  getProjectDb() {
    queries++;
    return db;
  },
  TaskStatus: { RUNNING: "running", FAILED: "failed", SUCCEEDED: "succeeded" },
}));
mock.module(modulePath("../../src/repositories/project.repository.ts"), () => ({
  projectRepository: {
    async findByRef(ref: string) {
      return { ref, db_name: "postgres", deleted_at: null };
    },
  },
}));
mock.module(modulePath("../../src/repositories/task.repository.ts"), () => ({
  taskRepository: {},
}));
mock.module(modulePath("../../src/services/index.ts"), () => ({
  backgroundFunctionWorker: {},
  projectService: {},
}));
mock.module(modulePath("../../src/services/pgmq.service.ts"), () => ({
  isPublicPgmqQueueName: () => true,
  pgmqService: {},
}));
mock.module(modulePath("../../src/middleware/auth.ts"), () => ({
  async verifyProjectJwt() {
    return null;
  },
  async requireProjectOrAdminAuth(request: Request) {
    return request.headers.get("authorization") === "Bearer fixture-backend"
      ? null
      : { status: 403, body: { error: "Forbidden" } };
  },
}));

try {
  const { taskRoutes } = await import("../../src/routes/tasks");
  const app = new Elysia().use(taskRoutes);
  const request = (path: string, authorized = true, method = "GET") =>
    app.handle(
      new Request(`http://localhost/v1/projects/${path}`, {
        method,
        headers: authorized ? { authorization: "Bearer fixture-backend" } : {},
      }),
    );
  assert.equal(
    (await request(`fixture/tasks/pgflow:${runId}`, false)).status,
    403,
  );
  assert.equal(queries, 0);
  const detail = await request(`fixture/tasks/pgflow:${runId}`);
  assert.equal(detail.status, 200);
  const task: unknown = await detail.json();
  assert.ok(
    task &&
      typeof task === "object" &&
      "status" in task &&
      task.status === "succeeded",
  );
  assert.ok("finished_steps" in task && task.finished_steps === 1);
  assert.ok("total_steps" in task && task.total_steps === 1);
  assert.equal(
    (await request(`another-project/tasks/pgflow:${runId}`)).status,
    404,
  );
  assert.equal((await request("fixture/tasks/pgflow:invalid")).status, 404);
  const list = await request(
    "fixture/tasks/?task_type=pgflow&status=succeeded&limit=1",
  );
  assert.equal(list.status, 200, await list.clone().text());
  const rows: unknown = await list.json();
  assert.ok(Array.isArray(rows) && rows.length === 1);
  assert.equal(
    (await request("fixture/tasks/?task_type=pgflow,edge_function")).status,
    400,
  );
  assert.equal(
    (await request("fixture/tasks/?task_type=pgflow&dlq=true")).status,
    400,
  );
  for (const action of ["cancel", "retry"]) {
    const result = await request(
      `fixture/tasks/pgflow:${runId}/${action}`,
      true,
      "POST",
    );
    assert.equal(result.status, 409);
    assert.deepEqual(await result.json(), {
      message: "Executor does not support this action",
      code: "TASK_ACTION_UNSUPPORTED",
    });
  }
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => app.handle(new Request(input, init)),
  );
  try {
    const client = createSupaCloudClient({
      supabase: createClient("http://localhost:54321", "fixture-key", {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }),
      managementApiUrl: "http://localhost",
      projectRef: "fixture",
      getAccessToken: () => "fixture-backend",
    });
    const result = await client.tasks.get(`pgflow:${runId}`);
    assert.equal(result.executor?.run_id, runId);
    assert.deepEqual(result.capabilities, { cancel: false, retry: false });
    assert.equal(
      (await client.tasks.list({ taskType: "pgflow", limit: 1 })).length,
      1,
    );
    fetch.mockImplementation(async () =>
      Response.json({
        id: `pgflow:${runId}`,
        project_ref: "fixture",
        status: "running",
        capabilities: { cancel: "yes", retry: false },
      }),
    );
    await assert.rejects(client.tasks.get(`pgflow:${runId}`));
  } finally {
    fetch.mockRestore();
  }
  await db.close();
  const unavailable = await request(`fixture/tasks/pgflow:${runId}`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    message: "Executor status is unavailable",
    code: "PGFLOW_TASKS_UNAVAILABLE",
  });
} finally {
  await db.close();
}
