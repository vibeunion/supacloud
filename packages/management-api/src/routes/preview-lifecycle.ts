import { Elysia, status, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import {
  closePreview,
  createProjectConfigPreviewStore,
  reclaimStoredPreviews,
  type PreviewStore,
} from "../services/preview-lifecycle.service";
import type { PreviewReclamationPorts } from "../services/preview-provisioning.service";

type PreviewCleanupPorts = PreviewReclamationPorts;

const params = t.Object({ ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }) });
const previewParams = t.Object({
  ...params.properties,
  previewRef: t.String({ pattern: "^(?:pr-\\d{1,10}|change-[A-Za-z0-9_-]{1,32})$" }),
});

/**
 * Lifecycle routes over the preview store. Reclamation requires the cleanup
 * ports; when they are not configured the routes answer `501` instead of
 * pretending a preview was reclaimed.
 */
export function createPreviewLifecycleRoutes(dependencies: {
  store: PreviewStore;
  ports?: PreviewCleanupPorts;
  authorize?: typeof requireProjectOrAdminAuth;
  now?: () => Date;
}) {
  const authorize = dependencies.authorize ?? requireProjectOrAdminAuth;
  const now = dependencies.now ?? (() => new Date());
  const unavailable = () => status(501, {
    code: "PREVIEW_RECLAMATION_UNAVAILABLE",
    error: "Preview reclamation ports are not configured",
  });
  return new Elysia({ prefix: "/v1/projects/:ref/previews", name: "preview-lifecycle" })
    .error(({ error }) => {
      if (error instanceof Error && "code" in error && (error.code === "validation" || error.code === "parse")) {
        return status(error.code === "parse" ? 400 : 422, { code: "PREVIEW_LIFECYCLE_INVALID", error: "Invalid preview lifecycle request" });
      }
      return status(500, { code: "PREVIEW_LIFECYCLE_FAILED", error: "Preview lifecycle request failed" });
    })
    .beforeHandle(async ({ request, params: values }) => {
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
    })
    .get("", {
      params,
      detail: { tags: ["previews"], summary: "List tracked preview environments without provisioning" },
    }, async ({ params: values }) => ({
      project_ref: values.ref,
      previews: await dependencies.store.list(values.ref),
    }))
    .delete("/:previewRef", {
      params: previewParams,
      detail: { tags: ["previews"], summary: "Reclaim one preview environment and remove its record" },
    }, async ({ params: values }) => {
      if (!dependencies.ports) return unavailable();
      const result = await closePreview(dependencies.store, dependencies.ports, values.ref, values.previewRef);
      if (!result) return status(404, { code: "PREVIEW_NOT_FOUND", error: "Preview not found" });
      return { project_ref: values.ref, ...result };
    })
    .post("/reclaim", {
      params,
      detail: { tags: ["previews"], summary: "Reclaim every timeout-due preview environment" },
    }, async ({ params: values }) => {
      if (!dependencies.ports) return unavailable();
      return { project_ref: values.ref, ...await reclaimStoredPreviews(dependencies.store, dependencies.ports, values.ref, now()) };
    });
}

function defaultStore(): PreviewStore {
  return createProjectConfigPreviewStore({
    readConfig: async (ref) => ((await projectRepository.findByRef(ref))?.config ?? null) as Record<string, unknown> | null,
    writeConfig: async (ref, config) => { await projectRepository.updateConfig(ref, config); },
  });
}

/** Default routes expose listing; reclamation stays disabled until cleanup ports are wired. */
export const previewLifecycleRoutes = createPreviewLifecycleRoutes({ store: defaultStore() });