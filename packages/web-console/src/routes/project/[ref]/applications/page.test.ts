import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const compiler: BunPlugin = {
  name: "application-dashboard-test",
  setup(builder) {
    builder.onResolve({ filter: /^(\$app\/(state|navigation)|svelte-i18n)$/ },
      () => ({ path: local("page.test-fixture.svelte.ts") }));
    builder.onResolve({ filter: /^\$lib\// }, ({ path }) =>
      ({ path: local(`../../../../lib/${path.slice(5)}.ts`) }));
    builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => ({
      contents: compileModule(new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text()),
        { filename: path, generate: "client" }).js.code, loader: "js",
    }));
    builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const source = await preprocess(await Bun.file(path).text(), vitePreprocess(), { filename: path });
      return { contents: compile(source.code, { filename: path, generate: "client", css: "injected" }).js.code, loader: "js" };
    });
  },
};
test("compiled application dashboard fences scope races, partial errors, pagination and unmount", async () => {
  if (process.env.APPLICATION_DASHBOARD_DOM_TEST !== "1") {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      env: { ...process.env, APPLICATION_DASHBOARD_DOM_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement,
    HTMLMediaElement: window.HTMLMediaElement,
    Element: window.Element, Node: window.Node, Text: window.Text, Comment: window.Comment,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window), MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  const output = join(tmpdir(), `application-dashboard-${crypto.randomUUID()}.mjs`);
  try {
    const result = await Bun.build({
      entrypoints: [local("page.test-entry.ts")], target: "browser", format: "esm",
      conditions: ["svelte", "browser"], external: ["node:assert"], plugins: [compiler],
    });
    if (!result.success) throw new AggregateError(result.logs, "Application dashboard fixture build failed");
    await Bun.write(output, result.outputs[0]!);
    await import(pathToFileURL(output).href);
  } finally {
    await rm(output, { force: true });
    dom.window.close();
  }
}, 30_000);
