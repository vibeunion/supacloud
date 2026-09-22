import { expect, spyOn, test } from "bun:test";
import type { BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProjectList, loadProjectList } from "../../lib/project-list";
import { projectListFixture, projectRecord } from "../../lib/project-list.test-fixtures";
import { publicProjectList } from "../../../../management-api/src/services/project-list-response";

test("project list projection keeps lifecycle fields without leaking private metadata or inventing defaults", () => {
  const input = {
    ...projectRecord(), db_password: "private-password", config: { secret: "private-config" },
  };
  const rows = publicProjectList([input]);
  expect(rows).toEqual([{
    id: "id-a", ref: "a", organization_id: "default", organization_slug: "default",
    name: "Project a", region: "local", created_at: "2026-09-01T00:00:00.000Z", status: "ACTIVE_HEALTHY",
  }]);
  expect(parseProjectList(rows)).toEqual([{
    id: "id-a", ref: "a", name: "Project a", region: "local", status: "ACTIVE_HEALTHY",
  }]);
  for (const [status, expected] of [["creating", "COMING_UP"], ["paused", "INACTIVE"], ["deleted", "INACTIVE"]]) {
    expect(publicProjectList([{ ...input, status }])[0]?.status).toBe(expected);
  }
  expect(publicProjectList([])).toEqual([]);
});

test("invalid identities, duplicates, absent status and bad timestamps cannot become public projects", () => {
  const valid = projectRecord();
  const inherited: unknown = Object.create(valid);
  for (const row of [
    null, [], {}, inherited, { ...valid, id: undefined }, { ...valid, ref: "../escape" },
    { ...valid, organization_id: undefined }, { ...valid, organization_slug: "" },
    { ...valid, region: "" }, { ...valid, name: "\0" }, { ...valid, status: undefined },
    { ...valid, status: "unexpected" }, { ...valid, created_at: undefined },
    { ...valid, created_at: new Date(NaN) }, { ...valid, created_at: "2026-02-30T00:00:00.000Z" },
  ]) expect(() => publicProjectList([row])).toThrow();
  expect(() => publicProjectList([valid, valid])).toThrow();
  expect(() => publicProjectList([valid, { ...projectRecord("b"), id: valid.id }])).toThrow();
});

test("Console accepts only complete validated arrays with unique safe project identities", () => {
  const valid = projectListFixture()[0];
  if (!valid) throw new Error("Missing project fixture");
  for (const value of [null, {}, { data: [] }, [null], [valid, valid],
    [valid, { ...valid, ref: "b" }], [{ ...valid, ref: "a?x=b" }],
    [{ ...valid, status: undefined }], [{ ...valid, status: "ACTIVE" }],
    [{ ...valid, name: false }], [{ ...valid, region: "" }],
  ]) expect(() => parseProjectList(value)).toThrow();
  expect(parseProjectList([])).toEqual([]);
  expect(parseProjectList([{ ...valid, api: "private", config: { token: "private" } }])[0]).not.toHaveProperty("config");
});

test("project list transport remains bounded and cannot turn failed reads into empty arrays", async () => {
  let calls = 0;
  const request = async (url: string, options: RequestInit) => {
    calls++;
    expect(url).toBe("/v1/projects");
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    return Response.json(projectListFixture());
  };
  expect(await loadProjectList(request, new AbortController().signal)).toHaveLength(1);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(loadProjectList(request, cancelled.signal)).rejects.toThrow();
  expect(calls).toBe(1);
  await expect(loadProjectList(async () => Response.json([], { status: 503 }), new AbortController().signal)).rejects.toThrow();
  await expect(loadProjectList(async () => new Response("x".repeat(1024 * 1024 + 1)), new AbortController().signal)).rejects.toThrow();
});

test("actual list routes preserve authorization, project scope and unavailable state", async () => {
  const { projectCrudRoutes } = await import("../../../../management-api/src/routes/project-crud");
  const { projectService } = await import("../../../../management-api/src/services");
  const { config } = await import("../../../../management-api/src/config");
  const authModule = await import("../../../../management-api/src/middleware/auth");
  const originalToken = config.masterToken;
  config.masterToken = "project-list-test-master-token";
  const list = spyOn(projectService, "listProjects").mockResolvedValue([projectRecord()]);
  const lookup = spyOn(projectService, "getProject").mockResolvedValue({ ...projectRecord(), config: {} });
  const app = projectCrudRoutes;
  const request = (suffix = "", authorized = true) => app.handle(new Request(`http://localhost/v1/projects${suffix}`, {
    headers: authorized ? { Authorization: "Bearer project-list-test-master-token" } : {},
  }));
  try {
    const denied = await request("", false);
    expect(denied.status, await denied.text()).toBe(401);
    expect(list).not.toHaveBeenCalled();
    for (const suffix of ["", "/"]) {
      const response = await request(suffix);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(parseProjectList(body)).toEqual(parseProjectList(projectListFixture()));
    }
    list.mockResolvedValue([{ ...projectRecord(), created_at: new Date(NaN) }]);
    expect((await request()).status).toBe(503);
    list.mockRejectedValue(new Error("private storage failure"));
    const unavailable = await request();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private storage failure");
    const auth = spyOn(authModule, "getAuthContext").mockResolvedValue({ role: "project", ref: "a", principalId: "project:a" });
    try {
      list.mockClear();
      const scoped = await request();
      expect(scoped.status).toBe(200);
      expect(parseProjectList(await scoped.json()).map(row => row.ref)).toEqual(["a"]);
      expect(list).not.toHaveBeenCalled();
      lookup.mockResolvedValue({ ...projectRecord("b"), config: {} });
      expect((await request()).status).toBe(503);
      lookup.mockResolvedValue(null);
      const missing = await request();
      expect(missing.status).toBe(200);
      expect(await missing.json()).toEqual([]);
    } finally { auth.mockRestore(); }
  } finally {
    list.mockRestore();
    lookup.mockRestore();
    config.masterToken = originalToken;
  }
});

const localFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));
function compiler(): BunPlugin {
  return {
    name: "project-list-tests",
    setup(builder) {
      builder.onResolve({ filter: /^\$app\/paths$/ }, () => ({ path: localFile("page.test-fixture.ts") }));
      builder.onResolve({ filter: /^\$lib\/(api|project-list)$/ },
        ({ path }) => ({ path: localFile(`../../lib/${path.slice("$lib/".length)}.ts`) }));
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await preprocess(await Bun.file(path).text(), vitePreprocess(), { filename: path });
        return { contents: compile(source.code, { filename: path, generate: "client", css: "injected" }).js.code, loader: "js" };
      });
    },
  };
}

test("compiled projects page distinguishes error from empty and disposes stale reads", async () => {
  if (process.env.SUPACLOUD_PROJECT_LIST_TEST !== "1") {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      env: { ...process.env, SUPACLOUD_PROJECT_LIST_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element, Node: window.Node, Text: window.Text, Comment: window.Comment,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window), MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  const bundlePath = join(tmpdir(), `supacloud-project-list-${crypto.randomUUID()}.mjs`);
  try {
    const result = await Bun.build({
      entrypoints: [localFile("page.test-entry.ts")], target: "browser", format: "esm",
      conditions: ["svelte", "browser"], external: ["node:assert"], plugins: [compiler()],
    });
    if (!result.success) throw new AggregateError(result.logs, "Project list fixture build failed");
    const output = result.outputs[0];
    if (!output) throw new Error("Missing project list fixture bundle");
    await Bun.write(bundlePath, output);
    await import(pathToFileURL(bundlePath).href);
  } finally {
    await rm(bundlePath, { force: true });
    dom.window.close();
  }
}, 30_000);
