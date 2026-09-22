import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const isolated = process.env.SUPACLOUD_AUTH_SETTINGS_TEST === "1";
const localFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));

function compiler(): BunPlugin {
  const typescript = new Bun.Transpiler({ loader: "ts" });
  return {
    name: "auth-settings-tests",
    setup(builder) {
      builder.onResolve({ filter: /^\$app\/state$/ }, () => ({ path: localFile("settings.test-state.svelte.ts") }));
      builder.onResolve({ filter: /^\$lib\/api$/ }, () => ({ path: localFile("settings.test-network.ts") }));
      builder.onResolve({ filter: /^\$lib\/auth-settings$/ }, () => ({ path: localFile("../../../../lib/auth-settings.ts") }));
      builder.onResolve({ filter: /^svelte-i18n$/ }, () => ({ path: "i18n", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export const t = { subscribe(run) { run(key => key); return () => {}; } };", loader: "js",
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

test("auth settings reject malformed boundaries and isolate mutations during project switches", async () => {
  if (!isolated) {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      env: { ...process.env, SUPACLOUD_AUTH_SETTINGS_TEST: "1" },
      stdout: "pipe", stderr: "pipe",
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
  const bundlePath = join(tmpdir(), `supacloud-auth-settings-${crypto.randomUUID()}.mjs`);
  try {
    const result = await Bun.build({
      entrypoints: [localFile("settings.test-entry.ts")],
      target: "browser", format: "esm", conditions: ["svelte", "browser"], external: ["node:assert"],
      plugins: [compiler()],
    });
    if (!result.success) throw new AggregateError(result.logs, "Auth settings fixture build failed");
    const output = result.outputs[0];
    if (!output) throw new Error("Missing auth settings fixture bundle");
    await Bun.write(bundlePath, output);
    await import(pathToFileURL(bundlePath).href);
  } finally {
    await rm(bundlePath, { force: true });
    dom.window.close();
  }
}, 30_000);
