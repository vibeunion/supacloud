import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { verifyAuthHookMessage } from "../services/auth-hook-message.service";
import {
  GOTRUE_HTTP_HOOK_NAMES,
  detectGoTrueAuthHookStatus,
  type GoTrueHttpHookName,
} from "../services/gotrue-auth-hook-runtime.service";
import { normalizeProjectConfig } from "../utils/project-config";
import { normalizeProjectRoutingConfig } from "../utils/project-routing";

function supportedHookName(hookName: string): hookName is GoTrueHttpHookName {
  return (GOTRUE_HTTP_HOOK_NAMES as readonly string[]).includes(hookName);
}

async function runtimeHookStatus(ref: string, hookName: string) {
  if (!supportedHookName(hookName)) {
    return status(404, { code: "NOT_FOUND", message: "GoTrue auth hook not found" });
  }
  const project = await projectRepository.findByRef(ref);
  if (!project) return status(404, { code: "NOT_FOUND", message: "Project not found" });
  const routing = normalizeProjectRoutingConfig(normalizeProjectConfig(project.config));
  return detectGoTrueAuthHookStatus(ref, hookName, routing);
}

export const projectAuthHookRuntimeRoutes = new Elysia({ prefix: "/v1/projects/:ref" })
  .onBeforeHandle(async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/auth/hooks/:hookName/status", async ({ params }) => {
    return runtimeHookStatus(params.ref, params.hookName);
  }, {
    params: t.Object({ ref: t.String(), hookName: t.String() }),
    detail: { tags: ["auth"], summary: "Get live GoTrue HTTP Auth Hook status" },
  })
  .post("/auth/hooks/:hookName/verify", async ({ params }) => {
    return runtimeHookStatus(params.ref, params.hookName);
  }, {
    params: t.Object({ ref: t.String(), hookName: t.String() }),
    body: t.Optional(t.Object({})),
    detail: { tags: ["auth"], summary: "Verify a live GoTrue HTTP Auth Hook" },
  })
  .post("/auth/hooks/:hookName/messages/verify", async ({ params, body }) => {
    if (!supportedHookName(params.hookName)) {
      return status(404, { code: "NOT_FOUND", message: "GoTrue auth hook not found" });
    }
    return verifyAuthHookMessage(params.ref, params.hookName, body);
  }, {
    params: t.Object({ ref: t.String(), hookName: t.String() }),
    body: t.Object({
      webhook_id: t.String({ maxLength: 256 }),
      webhook_timestamp: t.String({ maxLength: 64 }),
      webhook_signature: t.String({ maxLength: 4_096 }),
      body_base64: t.String({ maxLength: 700_000 }),
    }),
    detail: { tags: ["auth"], summary: "Verify and consume a GoTrue HTTP Auth Hook message" },
  });
