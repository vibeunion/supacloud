import { expect, test } from "bun:test";
import { createProjectNotebookRoutes } from "../../src/routes/project-notebooks";
import { normalizeNotebook, type Notebook, type NotebookScope, type NotebookStore } from "../../src/services/project-notebooks";

function fixture() {
  const rows = new Map<string, Notebook & { owner: string }>();
  const owned = (scope: NotebookScope, id: string) => {
    const row = rows.get(id);
    return row?.project_ref === scope.ref && row.owner === scope.owner ? row : null;
  };
  const store: NotebookStore = {
    async list(scope, offset) {
      return [...rows.values()].filter(row => row.project_ref === scope.ref && row.owner === scope.owner).slice(offset, offset + 201);
    },
    async read(scope, id) { return owned(scope, id); },
    async create(scope, name, content) {
      if ([...rows.values()].some(row => row.name === name && row.owner === scope.owner && row.project_ref === scope.ref)) return null;
      const row = { id: crypto.randomUUID(), project_ref: scope.ref, owner: scope.owner, name, content, revision: 1, content_bytes: Buffer.byteLength(content) };
      rows.set(row.id, row);
      return row;
    },
    async update(scope, id, revision, name, content) {
      const row = owned(scope, id);
      if (!row || row.revision !== revision) return null;
      if ([...rows.values()].some(other => other.id !== id && other.owner === scope.owner && other.project_ref === scope.ref && other.name === name)) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      const next = { ...row, name: name ?? row.name, content: content ?? row.content, revision: revision + 1 };
      next.content_bytes = Buffer.byteLength(next.content);
      rows.set(id, next);
      return next;
    },
    async delete(scope, id, revision) {
      if (owned(scope, id)?.revision !== revision) return false;
      return rows.delete(id);
    },
  };
  const app = createProjectNotebookRoutes({
    store, projectExists: async ref => ref !== "missing",
    authorize: async request => request.headers.has("authorization") ? undefined : { status: 401, body: { error: "Unauthorized" } },
    principal: async request => ({ id: request.headers.get("authorization") ?? "", type: "admin" }),
  });
  const request = (method: string, path = "", body?: unknown, actor = "alice", ref = "demo") =>
    app.handle(new Request(`http://localhost/v1/projects/${ref}/notebooks${path}`, {
      method, headers: { authorization: actor, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  return { app, request };
}

test("notebooks enforce project and owner scope, revisions, rename and delete conflicts", async () => {
  const { app, request } = fixture();
  expect((await app.handle(new Request("http://localhost/v1/projects/demo/notebooks"))).status).toBe(401);
  expect((await request("GET", "", undefined, "alice", "missing")).status).toBe(404);
  const created = await request("POST", "", { name: "分析", content: "select 1;" });
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("no-store");
  const row = await created.json();
  expect(row.revision).toBe(1);
  expect((await request("GET", `/${row.id}`, undefined, "bob")).status).toBe(404);
  expect((await request("GET", `/${row.id}`, undefined, "alice", "other")).status).toBe(404);
  expect((await request("POST", "", { name: "分析" })).status).toBe(409);
  expect((await request("PUT", `/${row.id}`, { content: "select 2;", expected_revision: 1 })).status).toBe(200);
  expect((await request("PUT", `/${row.id}`, { content: "lost", expected_revision: 1 })).status).toBe(409);
  expect((await request("DELETE", `/${row.id}`, { expected_revision: 1 })).status).toBe(409);
  await request("POST", "", { name: "reserved" });
  expect((await request("PUT", `/${row.id}`, { name: "reserved", expected_revision: 2 })).status).toBe(409);
  const download = await request("GET", `/${row.id}/download`);
  expect(download.headers.get("content-disposition")).toContain("filename*=UTF-8");
  expect(await download.text()).toBe("select 2;");
  const list = await (await request("GET")).json();
  expect(list.project_ref).toBe("demo");
  expect(list.items).toHaveLength(2);
  expect((await request("DELETE", `/${row.id}`, { expected_revision: 2 })).status).toBe(200);
  expect((await request("GET", `/${row.id}`)).status).toBe(404);
});

test("notebooks reject unsafe names, multibyte oversize bodies and unsafe revisions", async () => {
  const { request } = fixture();
  expect((await request("POST", "", { name: "../bad" })).status).toBe(400);
  expect((await request("POST", "", { name: "oversize", content: "中".repeat(333334) })).status).toBe(413);
  const row = { id: crypto.randomUUID(), project_ref: "demo", name: "demo", content: "", content_bytes: 0 };
  expect(normalizeNotebook({ ...row, revision: 2n }).revision).toBe(2);
  expect(normalizeNotebook({ ...row, revision: "3" }).revision).toBe(3);
  expect(() => normalizeNotebook({ ...row, revision: 9007199254740992n })).toThrow("revision");
});
