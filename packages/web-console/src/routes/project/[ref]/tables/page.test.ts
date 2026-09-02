import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { initialTableColumns, tableColumnWithType } from "./table-draft";

const packageRoot = new URL("../../../../../", import.meta.url);
const visibilityStorageKey = "svadmin-columns-v2-r:users|p:default|t:u";
let browserDom: JSDOM;

function svelteTestCompiler() {
  const typescript = new Bun.Transpiler({ loader: "ts" });
  return {
    name: "svelte-component-tests",
    setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const preprocessed = await preprocess(source, vitePreprocess(), { filename: path });
        const compiled = compile(preprocessed.code, {
          filename: path,
          generate: "client",
          css: "injected",
        });
        return { contents: compiled.js.code, loader: "js" };
      });
      builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const javascript = typescript.transformSync(source);
        const compiled = compileModule(javascript, { filename: path, generate: "client" });
        return { contents: compiled.js.code, loader: "js" };
      });
      builder.onLoad({ filter: /\.svelte\.js$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const compiled = compileModule(source, { filename: path, generate: "client" });
        return { contents: compiled.js.code, loader: "js" };
      });
    },
  };
}

async function autoTableHarness() {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("auto-table-visibility.test-entry.ts", import.meta.url))],
    target: "browser",
    format: "esm",
    conditions: ["svelte", "browser"],
    plugins: [svelteTestCompiler()],
  });
  if (!build.success) {
    throw new AggregateError(build.logs, "Failed to bundle the AutoTable browser harness");
  }
  const bundlePath = join(tmpdir(), `supacloud-auto-table-${randomUUID()}.mjs`);
  await Bun.write(bundlePath, build.outputs[0]!);
  try {
    return await import(pathToFileURL(bundlePath).href) as {
      mountHarness: (target: HTMLElement) => object;
      unmountHarness: (component: object) => Promise<void>;
    };
  } finally {
    await rm(bundlePath, { force: true });
  }
}

function installBrowserGlobals(): void {
  browserDom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const browserWindow = browserDom.window;
  Object.defineProperty(browserWindow, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
  const globals = {
    window: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    location: browserWindow.location,
    history: browserWindow.history,
    localStorage: browserWindow.localStorage,
    sessionStorage: browserWindow.sessionStorage,
    HTMLElement: browserWindow.HTMLElement,
    Element: browserWindow.Element,
    Node: browserWindow.Node,
    Text: browserWindow.Text,
    Comment: browserWindow.Comment,
    Event: browserWindow.Event,
    CustomEvent: browserWindow.CustomEvent,
    MouseEvent: browserWindow.MouseEvent,
    KeyboardEvent: browserWindow.KeyboardEvent,
    FocusEvent: browserWindow.FocusEvent,
    MutationObserver: browserWindow.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
    requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow),
    cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
  };
  Object.assign(globalThis, globals);
  Object.defineProperty(browserWindow.Element.prototype, "animate", {
    configurable: true,
    value: () => ({ cancel: () => {}, finished: Promise.resolve() }),
  });
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

function elementWithText(selector: string, text: string): HTMLElement {
  const element = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!element) throw new Error(`Cannot find ${selector} with text ${text}`);
  return element;
}

function desktopTable(): HTMLElement {
  const table = document.querySelector<HTMLElement>('[role="region"] .hidden.md\\:block');
  if (!table) throw new Error("Desktop table is unavailable");
  return table;
}

function mobileCards(): HTMLElement {
  const cards = document.querySelector<HTMLElement>('[role="region"] .md\\:hidden');
  if (!cards) throw new Error("Mobile cards are unavailable");
  return cards;
}

function expectEmailVisible(visible: boolean): void {
  const desktop = desktopTable();
  const headerVisible = Array.from(desktop.querySelectorAll("th"))
    .some((header) => header.textContent?.trim().startsWith("Email"));
  const cellVisible = Array.from(desktop.querySelectorAll("td"))
    .some((cell) => cell.textContent?.trim() === "user@example.com");
  const mobileText = mobileCards().textContent || "";
  expect(headerVisible).toBe(visible);
  expect(cellVisible).toBe(visible);
  expect(mobileText.includes("Email")).toBe(visible);
  expect(mobileText.includes("user@example.com")).toBe(visible);
}

async function toggleEmailColumn(): Promise<void> {
  const columnsButton = document.querySelector<HTMLButtonElement>('button[aria-label="Columns"]');
  if (!columnsButton) throw new Error("Cannot find the Columns button");
  columnsButton.click();
  await eventually(() => expect(elementWithText('[role="menuitemcheckbox"]', "Email")).toBeTruthy());
  elementWithText('[role="menuitemcheckbox"]', "Email").click();
}

beforeAll(() => {
  installBrowserGlobals();
});

afterAll(async () => {
  browserDom.window.close();
});

describe("database tables column visibility", () => {
  test("hides, persists, and restores a column in desktop and mobile views", async () => {
    const { mountHarness, unmountHarness } = await autoTableHarness();
    localStorage.clear();

    const firstTarget = document.body.appendChild(document.createElement("div"));
    const firstView = mountHarness(firstTarget);
    await eventually(() => expectEmailVisible(true));

    await toggleEmailColumn();
    await eventually(() => {
      expectEmailVisible(false);
      expect(JSON.parse(localStorage.getItem(visibilityStorageKey) || "{}").email).toBe(false);
    });

    await unmountHarness(firstView);
    firstTarget.remove();
    const secondTarget = document.body.appendChild(document.createElement("div"));
    const secondView = mountHarness(secondTarget);
    await eventually(() => expectEmailVisible(false));

    await toggleEmailColumn();
    await eventually(() => {
      expectEmailVisible(true);
      expect(JSON.parse(localStorage.getItem(visibilityStorageKey) || "{}").email).toBe(true);
    });

    await unmountHarness(secondView);
    secondTarget.remove();
  }, 90_000);

  test("pins the released SvAdmin UI dependency exactly", async () => {
    const packageJson = await Bun.file(new URL("package.json", packageRoot)).json();
    const lockSource = await Bun.file(new URL("bun.lock", packageRoot)).text();

    expect(packageJson.dependencies["@svadmin/ui"]).toBe("0.67.1");
    expect(lockSource).toContain('"@svadmin/ui": "0.67.1"');
    expect(lockSource).toContain('"@svadmin/ui@0.67.1"');
  });

  test("keeps unavailable row estimates from rendering as negative counts", async () => {
    const source = await Bun.file(new URL("+page.svelte", import.meta.url)).text();
    const autoTableSource = await Bun.file(
      fileURLToPath(import.meta.resolve("@svadmin/ui/components/AutoTable.svelte")),
    ).text();
    expect(source).toContain("count >= 0");
    expect(source).toContain('count === null ? "—"');
    expect(autoTableSource).toContain("whitespace-nowrap");
    expect(autoTableSource).toContain("gap-3 px-1 py-2");
  });

  test("keeps each create-table draft bound to its own DOM row", async () => {
    const source = await Bun.file(new URL("+page.svelte", import.meta.url)).text();

    expect(source).toContain("{#each columns as column, index (column)}");
    expect(source).not.toContain("{#each columns as column, index (index)}");
  });

  test("allows the default primary-key type to change without sending an invalid identity", async () => {
    const source = await Bun.file(new URL("+page.svelte", import.meta.url)).text();
    const initialId = initialTableColumns()[0]!;

    expect(source).not.toContain("disabled={index === 0}");
    expect(source).toContain("updateColumnType(index, event.currentTarget.value as TableColumnType)");
    expect(tableColumnWithType(initialId, "integer")).toMatchObject({
      type: "integer",
      identity: true,
      primaryKey: true,
    });
    expect(tableColumnWithType(initialId, "uuid")).toMatchObject({
      type: "uuid",
      identity: false,
      primaryKey: true,
    });
  });
});
