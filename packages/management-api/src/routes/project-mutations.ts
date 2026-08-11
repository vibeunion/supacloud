import { Elysia, status } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import {
  isProjectMutationId,
  publicProjectMutation,
  readProjectMutation,
} from "../services/project-mutation.service";

const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;

export const projectMutationRoutes = new Elysia({ prefix: "/v1/projects/:ref/mutations" })
  .onBeforeHandle(async ({ params, request }) => {
    if (!PROJECT_REF_PATTERN.test(params.ref)) return status(400, { error: "Project ref is invalid" });
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/:mutationId", async ({ params }) => {
    if (!isProjectMutationId(params.mutationId)) {
      return status(400, { error: "mutation_id must be a UUIDv4" });
    }
    const mutation = await readProjectMutation({
      projectRef: params.ref,
      mutationId: params.mutationId,
    });
    if (!mutation) return status(404, { error: "Mutation not found" });
    return { project_ref: params.ref, mutation: publicProjectMutation(mutation) };
  }, {
    detail: { tags: ["mutations"], summary: "Read a durable project mutation" },
  });
