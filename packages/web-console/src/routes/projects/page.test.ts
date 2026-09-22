import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProjectList, loadProjectList } from "../../lib/project-list";
import { projectListFixture } from "../../lib/project-list.test-fixtures";

test("project list decoder keeps lifecycle fields without leaking private metadata or inventing defaults", () => {
  const rows = projectListFixture();
  expect(parseProjectList(rows)).toEqual([{
    id: "id-a", ref: "a", name: "Project a", region: "local", status: "ACTIVE_HEALTHY",
  }]);
  const valid = rows[0];
  if (!valid) throw new Error("Missing project fixture");
  expect(parseProjectList([{ ...valid, api: "private", config: { token: "private" } }])[0]).not.toHaveProperty("config");
  expect(parseProjectList([])).toEqual([]);
});

test("invalid identities, duplicates, absent status and bad timestamps cannot become public projects", () => {
  const valid = projectListFixture()[0];
  if (!valid) throw new Error("Missing project fixture");
  const inherited: unknown = Object.create(valid);
  for (const row of [
    null, [], {}, inherited, { ...valid, id: undefined }, { ...valid, ref: "../escape" },
    { ...valid, name: "\0" }, { ...valid, status: undefined }, { ...valid, status: "unexpected" },
  ]) expect(() => parseProjectList([row])).toThrow();
  expect(() => parseProjectList([valid, valid])).toThrow();
  expect(() => parseProjectList([valid, { ...projectListFixture(["b"])[0], id: valid.id }])).toThrow();
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
