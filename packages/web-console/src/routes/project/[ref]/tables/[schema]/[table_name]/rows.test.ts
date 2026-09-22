import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const localFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));
function compiler(): BunPlugin {
  const typescript = new Bun.Transpiler({ loader: "ts" });
  return {
    name: "table-rows-tests",
    setup(builder) {
      builder.onResolve({ filter: /^(\$app\/(state|paths)|\$lib\/api)$/ },
        () => ({ path: localFile("rows.test-fixture.svelte.ts") }));
      builder.onResolve({ filter: /^\$lib\// }, ({ path }) => ({
        path: localFile(`../../../../../../lib/${path.slice(5)}${path.endsWith(".svelte") ? "" : ".ts"}`),
      }));
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await preprocess(await Bun.file(path).text(), vitePreprocess(), { filename: path });
        return { contents: compile(source.code, { filename: path, generate: "client", css: "injected" }).js.code, loader: "js" };
      });
      builder.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        return {
          contents: compileModule(path.endsWith(".ts") ? typescript.transformSync(source) : source, { filename: path, generate: "client" }).js.code,
          loader: "js",
        };
      });
    },
  };
}

test("real table rows isolate project context, metadata errors and stale navigation responses", async () => {
  if (process.env.SUPACLOUD_TABLE_ROWS_TEST !== "1") {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      env: { ...process.env, SUPACLOUD_TABLE_ROWS_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator, location: window.location, history: window.history,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement, HTMLInputElement: window.HTMLInputElement,
    Element: window.Element, Node: window.Node, Text: window.Text, Comment: window.Comment,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent, FocusEvent: window.FocusEvent, MutationObserver: window.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (media: string) => ({
    matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {},
    removeListener() {}, dispatchEvent: () => false,
  }) });
  Object.defineProperty(window.Element.prototype, "animate", {
    configurable: true, value: () => ({ cancel() {}, finished: Promise.resolve() }),
  });
  const path = join(tmpdir(), `supacloud-table-rows-${crypto.randomUUID()}.mjs`);
  try {
    const result = await Bun.build({
      entrypoints: [localFile("rows.test-entry.ts")], target: "browser", format: "esm",
      conditions: ["svelte", "browser"], external: ["node:assert"], plugins: [compiler()],
    });
    if (!result.success) throw new AggregateError(result.logs, "Table rows fixture build failed");
    const output = result.outputs[0];
    if (!output) throw new Error("Missing table rows fixture bundle");
    await Bun.write(path, output);
    await import(pathToFileURL(path).href);
  } finally {
    await rm(path, { force: true });
    dom.window.close();
  }
}, 90_000);
