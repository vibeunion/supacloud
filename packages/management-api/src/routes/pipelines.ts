import { Elysia, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { PipelineError, pipelineService } from "../services/pipeline.service";

function authResponse(authError: { status: number; body: { error: string } }, set: { status?: number | string }) {
  set.status = authError.status;
  return { message: authError.body.error, code: String(authError.status), status: authError.status };
}

async function run<T>(set: { status?: number | string }, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PipelineError) {
      set.status = error.statusCode;
      return { message: error.message, code: error.code, status: error.statusCode };
    }
    throw error;
  }
}

const pipelineBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  publication_name: t.String({ minLength: 1, maxLength: 63 }),
  destination: t.Object({
    type: t.Literal("bigquery"),
    project_id: t.String({ minLength: 1, maxLength: 128 }),
    dataset_id: t.String({ minLength: 1, maxLength: 63 }),
    service_account_key: t.String({ minLength: 1, maxLength: 64 * 1024 }),
    max_staleness_mins: t.Optional(t.Number()),
  }),
  batch_wait_ms: t.Optional(t.Number()),
  sync_workers: t.Optional(t.Number()),
  slot_recovery: t.Optional(t.Union([t.Literal("error"), t.Literal("recreate")])),
});

export const pipelineRoutes = new Elysia({ prefix: "/v1/projects/:ref/pipelines" })
  .get("/", async ({ params, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, () => pipelineService.list(params.ref));
  }, { detail: { tags: ["projects", "pipelines"], summary: "List CDC pipelines" } })
  .post("/", async ({ params, body, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    const result = await run(set, () => pipelineService.create(params.ref, body));
    if (!(result as { status?: number }).status) set.status = 201;
    return result;
  }, { body: pipelineBody, detail: { tags: ["projects", "pipelines"], summary: "Create a BigQuery CDC pipeline" } })
  .get("/:id", async ({ params, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, async () => (await pipelineService.find(params.ref, params.id)).public);
  }, { detail: { tags: ["projects", "pipelines"], summary: "Get CDC pipeline status" } })
  .post("/:id/:action", async ({ params, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    if (!(["start", "stop", "restart"] as string[]).includes(params.action)) {
      set.status = 404;
      return { message: "Unknown pipeline action", code: "pipeline_action_not_found", status: 404 };
    }
    return run(set, () => pipelineService.action(params.ref, params.id, params.action as "start" | "stop" | "restart"));
  }, { detail: { tags: ["projects", "pipelines"], summary: "Start, stop, or restart a CDC pipeline" } })
  .delete("/:id", async ({ params, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, () => pipelineService.remove(params.ref, params.id));
  }, { detail: { tags: ["projects", "pipelines"], summary: "Delete a CDC pipeline" } });
