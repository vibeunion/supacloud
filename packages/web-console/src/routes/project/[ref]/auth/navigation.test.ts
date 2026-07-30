import { describe, expect, test } from "bun:test";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile, compileModule, preprocess } from "svelte/compiler";

let browserDom: JSDOM;
const runsInIsolatedProcess = process.env.SUPACLOUD_AUTH_NAVIGATION_TEST === "1";

function svelteTestCompiler() {
  const typescript = new Bun.Transpiler({ loader: "ts" });
  return {
    name: "auth-navigation-component-tests",
    setup(builder) {
      builder.onResolve({ filter: /^\$app\/paths$/ }, () => ({ path: "app-paths", namespace: "auth-navigation-stub" }));
      builder.onResolve({ filter: /^\$app\/state$/ }, () => ({ path: "app-state", namespace: "auth-navigation-stub" }));
      builder.onResolve({ filter: /^\$lib\/api$/ }, () => ({ path: "api", namespace: "auth-navigation-stub" }));
      builder.onResolve({ filter: /^svelte-i18n$/ }, () => ({ path: "i18n", namespace: "auth-navigation-stub" }));
      builder.onLoad({ filter: /.*/, namespace: "auth-navigation-stub" }, ({ path }) => {
        const stubSources: Record<string, string> = {
          "app-paths": "export const resolve = (route, params) => route.replace('[ref]', params.ref);",
          "app-state": "export const page = { params: { ref: 'project-ref' }, url: { pathname: '/project/project-ref/auth' } };",
          "api": `export async function apiClient() {
            return new Response(JSON.stringify({
              project_ref: 'project-ref', mode: 'local', authority_project_ref: 'project-ref', owner_project_ref: null,
              local_gotrue_enabled: true, public_auth_route: 'local_gotrue', user_management: 'local',
              configuration_management: 'local', local_membership_source: 'project_database', realtime_auth_supported: true,
              owner_management_path: null,
            }), { status: 200 });
          }`,
          "i18n": "export const t = { subscribe(run) { run((key) => String(key)); return () => {}; } };",
        };
        return { contents: stubSources[path], loader: "js" };
      });
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const preprocessed = await preprocess(source, vitePreprocess(), { filename: path });
        const compiled = compile(preprocessed.code, { filename: path, generate: "client", css: "injected" });
        return { contents: compiled.js.code, loader: "js" };
      });
      builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const javascript = typescript.transformSync(source);
        const compiled = compileModule(javascript, { filename: path, generate: "client" });
        return { contents: compiled.js.code, loader: "js" };
      });
    },
  };
}

async function authNavigationHarness() {
  const harnessBuild = await Bun.build({
    entrypoints: [fileURLToPath(new URL("navigation.test-entry.ts", import.meta.url))],
    target: "browser",
    format: "esm",
    conditions: ["svelte", "browser"],
    plugins: [svelteTestCompiler()],
  });
  if (!harnessBuild.success) throw new AggregateError(harnessBuild.logs, "Failed to bundle the auth navigation harness");

  const bundlePath = join(tmpdir(), `supacloud-auth-navigation-${randomUUID()}.mjs`);
  await Bun.write(bundlePath, harnessBuild.outputs[0]!);
  try {
    const harness = await import(pathToFileURL(bundlePath).href) as {
      mountHarness: (target: HTMLElement) => object;
      unmountHarness: (component: object) => Promise<void>;
    };
    return { ...harness, cleanup: () => rm(bundlePath, { force: true }) };
  } catch (error) {
    await rm(bundlePath, { force: true });
    throw error;
  }
}

function installBrowserGlobals(): void {
  browserDom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const browserWindow = browserDom.window;
  const browserGlobals = {
    window: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    location: browserWindow.location,
    history: browserWindow.history,
    HTMLElement: browserWindow.HTMLElement,
    Element: browserWindow.Element,
    Node: browserWindow.Node,
    Text: browserWindow.Text,
    Comment: browserWindow.Comment,
    Event: browserWindow.Event,
    CustomEvent: browserWindow.CustomEvent,
    MouseEvent: browserWindow.MouseEvent,
    KeyboardEvent: browserWindow.KeyboardEvent,
    MutationObserver: browserWindow.MutationObserver,
    getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
    requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow),
    cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
  };
  Object.assign(globalThis, browserGlobals);
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = performance.now() + 3_000;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(10);
    }
  }
  throw lastError;
}

function messagingButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === "AuthNav.messaging");
  if (!button) throw new Error("Messaging menu trigger is unavailable");
  return button;
}

function openMessagingMenu(): HTMLButtonElement {
  const button = messagingButton();
  button.click();
  return button;
}

if (runsInIsolatedProcess) describe("auth navigation", () => {
  test("opens and closes Email and Links reliably while preserving its navigation link", async () => {
    installBrowserGlobals();
    let target: HTMLElement | undefined;
    let component: object | undefined;
    let unmountHarness: ((component: object) => Promise<void>) | undefined;
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const harness = await authNavigationHarness();
      unmountHarness = harness.unmountHarness;
      cleanup = harness.cleanup;
      target = document.body.appendChild(document.createElement("div"));
      component = harness.mountHarness(target);
      await eventually(() => expect(messagingButton()).toBeTruthy());

      const trigger = openMessagingMenu();
      await eventually(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      if (!menu) throw new Error("Messaging menu is unavailable");
      const urlConfiguration = menu.querySelector<HTMLAnchorElement>('a[href="/project/project-ref/auth/url-configuration"]');
      if (!urlConfiguration) throw new Error("URL configuration link is unavailable");
      let navigationPreventedByMenu: boolean | undefined;
      urlConfiguration.addEventListener("click", (event) => {
        navigationPreventedByMenu = event.defaultPrevented;
        event.preventDefault();
      });
      const navigationEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
      urlConfiguration.dispatchEvent(navigationEvent);
      expect(navigationPreventedByMenu).toBe(false);
      await eventually(() => expect(document.querySelector('[role="menu"]')).toBeNull());

      const escapeTrigger = openMessagingMenu();
      await eventually(() => expect(escapeTrigger.getAttribute("aria-expanded")).toBe("true"));
      escapeTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await eventually(() => expect(document.querySelector('[role="menu"]')).toBeNull());
      expect(document.activeElement).toBe(escapeTrigger);

      openMessagingMenu();
      await eventually(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await eventually(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    } finally {
      if (component && unmountHarness) await unmountHarness(component);
      target?.remove();
      await cleanup?.();
      browserDom.window.close();
    }
  }, 30_000);
});

if (!runsInIsolatedProcess) {
  test("auth navigation regression runs in an isolated browser process", async () => {
    const bunExecutable = Bun.which("bun");
    if (!bunExecutable) throw new Error("Bun is required to run the auth navigation regression");
    const testPath = fileURLToPath(import.meta.url);
    const childProcess = Bun.spawn({
      cmd: [bunExecutable, "test", testPath],
      cwd: process.cwd(),
      env: { ...process.env, SUPACLOUD_AUTH_NAVIGATION_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      childProcess.exited,
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  }, 40_000);
}
