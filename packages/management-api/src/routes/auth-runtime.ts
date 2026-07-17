import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { projectService } from "../services";
import {
  getAuthRuntimeDescriptor,
  getAuthRuntimeManagedError,
  type AuthRuntimeManagedResource,
} from "../services/auth-runtime.service";

type AuthRuntimeGuardContext = {
  params: Record<string, string>;
  request: Request;
};

export function requireAuthRuntimeManagement(resource: AuthRuntimeManagedResource) {
  return async ({ params, request }: AuthRuntimeGuardContext) => {
    const ref = params.ref;
    if (!ref) return;

    const authError = await requireProjectOrAdminAuth(request, ref);
    if (authError) return status(authError.status, authError.body);

    const managedError = getAuthRuntimeManagedError(ref, resource);
    if (managedError) return status(409, managedError);
  };
}

export const authRuntimeRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .get(
    "/runtime",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);

      const project = await projectService.getProject(params.ref);
      if (!project) {
        return status(404, { message: "Project not found", code: "404" });
      }

      return getAuthRuntimeDescriptor(params.ref);
    },
    {
      params: t.Object({ ref: t.String() }),
      detail: { tags: ["auth"], summary: "Get project auth runtime ownership" },
    },
  );
