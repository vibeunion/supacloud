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
  let components = 0;
  return {
    name: "task-center-tests",
    setup(builder) {
      builder.onResolve({ filter: /^(\$app\/(state|paths)|\$lib\/api|svelte-i18n|svelte-sonner)$/ },
        () => ({ path: localFile("page.test-fixture.svelte.ts") }));
      builder.onResolve({ filter: /^\$lib\/task-center$/ }, () => ({ path: localFile("../../../../lib/task-center.ts") }));
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        if (process.env.SUPACLOUD_TASK_CENTER_TRACE === "1" && ++components % 250 === 0) {
          console.error(`Task Center fixture: compiling component ${components}`);
        }
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
test("compiled task center validates boundaries and isolates project, selection and mutation state", async () => {
  if (process.env.SUPACLOUD_TASK_CENTER_TEST !== "1") {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      env: { ...process.env, SUPACLOUD_TASK_CENTER_TEST: "1" }, stdout: "pipe", stderr: "pipe",
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
    HTMLTableRowElement: window.HTMLTableRowElement,
    Element: window.Element, Node: window.Node, Text: window.Text, Comment: window.Comment,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent, MessageEvent: window.MessageEvent,
    getComputedStyle: window.getComputedStyle.bind(window), MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  const bundlePath = join(tmpdir(), `supacloud-task-center-${crypto.randomUUID()}.mjs`);
  try {
    const started = performance.now();
    if (process.env.SUPACLOUD_TASK_CENTER_TRACE === "1") console.error("Task Center fixture: build started");
    const result = await Bun.build({
      entrypoints: [localFile("page.test-entry.ts")], target: "browser", format: "esm",
      conditions: ["svelte", "browser"], external: ["node:assert"], plugins: [compiler()],
    });
    if (!result.success) throw new AggregateError(result.logs, "Task Center fixture build failed");
    const output = result.outputs[0];
    if (!output) throw new Error("Missing Task Center fixture bundle");
    if (process.env.SUPACLOUD_TASK_CENTER_TRACE === "1") console.error(`Task Center fixture: build completed in ${performance.now() - started}ms`);
    await Bun.write(bundlePath, output);
    await import(pathToFileURL(bundlePath).href);
    if (process.env.SUPACLOUD_TASK_CENTER_TRACE === "1") console.error(`Task Center fixture: assertions completed in ${performance.now() - started}ms`);
  } finally {
    await rm(bundlePath, { force: true });
    dom.window.close();
  }
}, 30_000);
