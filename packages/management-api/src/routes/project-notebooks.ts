import { Elysia, status, t } from "elysia";
import { getVerifiedRequestPrincipal, requireProjectOrAdminAuth } from "../middleware/auth";
import { projectService } from "../services";
import { notebookStore, type NotebookScope, type NotebookStore } from "../services/project-notebooks";

const NOTEBOOK_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,159}$/u;
const NOTEBOOK_MAX_BYTES = 1_000_000;
const refParams = t.Object({ ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }) });
const idParams = t.Object({
  ...refParams.properties,
  id: t.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" }),
});
const revisionSchema = t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const nameSchema = t.String({ maxLength: 160 });
const contentSchema = t.String({ maxLength: NOTEBOOK_MAX_BYTES });
const nameConflict = () => status(409, { code: "NOTEBOOK_NAME_CONFLICT", message: "Notebook name already exists" });

interface Dependencies {
  store?: NotebookStore;
  authorize?: typeof requireProjectOrAdminAuth;
  principal?: typeof getVerifiedRequestPrincipal;
  projectExists?: (ref: string) => Promise<boolean>;
}

export function createProjectNotebookRoutes(dependencies: Dependencies = {}) {
  const store = dependencies.store ?? notebookStore;
  const authorize = dependencies.authorize ?? requireProjectOrAdminAuth;
  const principal = dependencies.principal ?? getVerifiedRequestPrincipal;
  const exists = dependencies.projectExists ?? (async ref => (await projectService.getProject(ref)) !== null);
  const scopes = new WeakMap<Request, NotebookScope>();
  const scope = (request: Request) => {
    const value = scopes.get(request);
    if (!value) throw new Error("Notebook authorization missing");
    return value;
  };
  const missingOrConflict = async (request: Request, id: string) => {
    const current = await store.read(scope(request), id);
    return current
      ? status(409, { code: "NOTEBOOK_REVISION_CONFLICT", revision: current.revision })
      : status(404, { message: "Notebook not found" });
  };
  return new Elysia({ prefix: "/v1/projects", name: "project-notebooks" })
  .error(({ error }) => {
    if (error instanceof Error) {
      if (("code" in error && error.code === "23505") || ("errno" in error && error.errno === "23505")) return nameConflict();
      if ("code" in error && (error.code === "validation" || error.code === "parse")) {
        return status(400, { message: "Invalid notebook request" });
      }
    }
    return status(500, { message: "Notebook storage unavailable" });
  })
  .beforeHandle(async ({ request, params, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const denied = await authorize(request, params.ref);
    if (denied) return status(denied.status, denied.body);
    if (!await exists(params.ref)) return status(404, { message: "Project not found" });
    const actor = await principal(request);
    if (!actor) return status(403, { message: "Notebook access denied" });
    scopes.set(request, { ref: params.ref, owner: `${actor.type}:${actor.id}` });
  })
  .get(
    "/:ref/notebooks",
    {
      params: refParams,
      query: t.Object({ offset: t.Optional(t.Numeric({ minimum: 0, maximum: 1_000_000, multipleOf: 1 })) }),
      detail: { tags: ["projects"], summary: "List SQL notebooks" },
    },
    async ({ request, query }) => {
      const offset = query.offset ?? 0;
      const items = await store.list(scope(request), offset);
      return { project_ref: scope(request).ref, items: items.slice(0, 200), next_offset: items.length > 200 ? offset + 200 : null };
    },
  )
  .post(
    "/:ref/notebooks",
    {
      params: refParams,
      body: t.Object({ name: nameSchema, content: t.Optional(contentSchema) }),
      detail: { tags: ["projects"], summary: "Create SQL notebook" },
    },
    async ({ body, request }) => {
      if (!NOTEBOOK_NAME.test(body.name.trim())) return status(400, { message: "Invalid notebook name" });
      const content = body.content ?? "";
      if (Buffer.byteLength(content) > NOTEBOOK_MAX_BYTES) return status(413, { message: "Notebook is too large" });
      const row = await store.create(scope(request), body.name.trim(), content);
      if (!row) return nameConflict();
      return status(201, row);
    },
  )
  .get(
    "/:ref/notebooks/:id",
    { params: idParams, detail: { tags: ["projects"], summary: "Get SQL notebook" } },
    async ({ params, request }) => {
      const row = await store.read(scope(request), params.id);
      return row ?? status(404, { message: "Notebook not found" });
    },
  )
  .get(
    "/:ref/notebooks/:id/download",
    { params: idParams, detail: { tags: ["projects"], summary: "Download SQL notebook" } },
    async ({ params, request }) => {
      const row = await store.read(scope(request), params.id);
      if (!row) return status(404, { message: "Notebook not found" });
      return new Response(String(row.content), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${row.name.replace(/[^A-Za-z0-9_.-]/g, "_")}.sql"; filename*=UTF-8''${encodeURIComponent(`${row.name}.sql`)}`,
        },
      });
    },
  )
  .put(
    "/:ref/notebooks/:id",
    {
      params: idParams,
      body: t.Object({ name: t.Optional(nameSchema), content: t.Optional(contentSchema), expected_revision: revisionSchema }),
      detail: { tags: ["projects"], summary: "Update SQL notebook" },
    },
    async ({ params, body, request }) => {
      if (body.name !== undefined && !NOTEBOOK_NAME.test(body.name.trim())) return status(400, { message: "Invalid notebook name" });
      if (body.content !== undefined && Buffer.byteLength(body.content) > NOTEBOOK_MAX_BYTES) return status(413, { message: "Notebook is too large" });
      const row = await store.update(scope(request), params.id, body.expected_revision, body.name?.trim(), body.content);
      return row ?? missingOrConflict(request, params.id);
    },
  )
  .delete(
    "/:ref/notebooks/:id",
    {
      params: idParams,
      body: t.Object({ expected_revision: revisionSchema }),
      detail: { tags: ["projects"], summary: "Delete SQL notebook" },
    },
    async ({ params, body, request }) => {
      return await store.delete(scope(request), params.id, body.expected_revision)
        ? { deleted: true } : missingOrConflict(request, params.id);
    },
  );
}

export const projectNotebookRoutes = createProjectNotebookRoutes();
