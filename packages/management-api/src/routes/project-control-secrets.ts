import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { projectService } from "../services";
import { resolveTrustedPrincipal } from "../services/bff-proof.service";
import {
  requireCapability,
  type CollaboratorCapability,
} from "../services/project-collaborator.service";
import {
  isControlSecretScope,
  projectControlSecretsService,
} from "../services/project-control-secrets.service";
import { isAppError, ValidationError } from "../utils/errors";

function invalidSecretInput(error: unknown) {
  if (!(error instanceof ValidationError)) throw error;
  return status(400, {
    code: "INVALID_CONTROL_SECRET",
    message: error.message,
  });
}

async function requireSecretProject(request: Request, ref: string) {
  const authError = await requireProjectOrAdminAuth(request, ref);
  if (authError) return status(authError.status, authError.body);
  if (!(await projectService.getProject(ref))) {
    return status(404, { code: "NOT_FOUND", message: "Project not found" });
  }
  try {
    const actor = await resolveTrustedPrincipal(request, ref);
    await requireCapability(ref, actor, secretCapability(request));
  } catch (error) {
    if (isAppError(error)) return status(error.statusCode, error.toJSON());
    throw error;
  }
  return null;
}

function secretCapability(request: Request): CollaboratorCapability {
  return request.method === "GET" ? "security.read" : "security.manage";
}

export const projectControlSecretsRoutes = new Elysia({ prefix: "/v1/projects" })
  .get(
    "/:ref/control-secrets/:scope",
    async ({ params, request }) => {
      const authError = await requireSecretProject(request, params.ref);
      if (authError) return authError;
      if (!isControlSecretScope(params.scope)) {
        return status(400, { code: "INVALID_SECRET_SCOPE", message: "Unsupported control secret scope" });
      }
      const items = await projectControlSecretsService.listStatuses(params.ref, params.scope);
      return { items, total: items.length };
    },
    {
      params: t.Object({ ref: t.String(), scope: t.String() }),
      detail: { tags: ["projects"], summary: "List masked control secret status" },
    },
  )
  .get(
    "/:ref/control-secrets/:scope/:name",
    async ({ params, request }) => {
      const authError = await requireSecretProject(request, params.ref);
      if (authError) return authError;
      if (!isControlSecretScope(params.scope)) {
        return status(400, { code: "INVALID_SECRET_SCOPE", message: "Unsupported control secret scope" });
      }
      try {
        return await projectControlSecretsService.getStatus(params.ref, params.scope, params.name);
      } catch (error) {
        return invalidSecretInput(error);
      }
    },
    {
      params: t.Object({ ref: t.String(), scope: t.String(), name: t.String() }),
      detail: { tags: ["projects"], summary: "Get masked control secret status" },
    },
  )
  .put(
    "/:ref/control-secrets/:scope/:name",
    async ({ params, body, request }) => {
      const authError = await requireSecretProject(request, params.ref);
      if (authError) return authError;
      if (!isControlSecretScope(params.scope)) {
        return status(400, { code: "INVALID_SECRET_SCOPE", message: "Unsupported control secret scope" });
      }
      try {
        return await projectControlSecretsService.upsert(params.ref, params.scope, params.name, body.value);
      } catch (error) {
        return invalidSecretInput(error);
      }
    },
    {
      params: t.Object({ ref: t.String(), scope: t.String(), name: t.String() }),
      body: t.Object({ value: t.String({ minLength: 1, maxLength: 24576 }) }),
      detail: { tags: ["projects"], summary: "Create or rotate a control secret without revealing it" },
    },
  )
  .delete(
    "/:ref/control-secrets/:scope/:name",
    async ({ params, request }) => {
      const authError = await requireSecretProject(request, params.ref);
      if (authError) return authError;
      if (!isControlSecretScope(params.scope)) {
        return status(400, { code: "INVALID_SECRET_SCOPE", message: "Unsupported control secret scope" });
      }
      try {
        return await projectControlSecretsService.remove(params.ref, params.scope, params.name);
      } catch (error) {
        return invalidSecretInput(error);
      }
    },
    {
      params: t.Object({ ref: t.String(), scope: t.String(), name: t.String() }),
      detail: { tags: ["projects"], summary: "Delete a control secret" },
    },
  );
