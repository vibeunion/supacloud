import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  anyAbortSignal,
  canParseUrl,
  installAbortSignalAnyPolyfill,
  installBrowserCompatPolyfills,
  installRandomUuidPolyfill,
  installUrlCanParsePolyfill,
  randomUuid,
} from "./browser_compat";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeCrypto(bytes = new Uint8Array(16)) {
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array instanceof Uint8Array) array.set(bytes.subarray(0, array.length));
      return array;
    },
  };
}

describe("URL.canParse compatibility", () => {
  test("parses absolute URLs and relative references with a base", () => {
    expect(canParseUrl("https://api.example.com/v1")).toBe(true);
    expect(canParseUrl("/v1/items", "https://api.example.com")).toBe(true);
    expect(canParseUrl("/v1/items")).toBe(false);
    expect(canParseUrl("http://[::1")).toBe(false);
    expect(canParseUrl("https://api.example.com", "not a base")).toBe(false);
  });

  test("only fills a missing implementation", () => {
    const missing: { canParse?: unknown } = {};
    installUrlCanParsePolyfill(missing);
    expect(typeof missing.canParse).toBe("function");
    expect((missing.canParse as typeof canParseUrl)("https://api.example.com")).toBe(true);

    const native = () => false;
    const existing: { canParse?: unknown } = { canParse: native };
    installUrlCanParsePolyfill(existing);
    expect(existing.canParse).toBe(native);
  });
});

describe("AbortSignal.any compatibility", () => {
  test("aborts when any signal aborts and preserves the reason", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = anyAbortSignal([first.signal, second.signal]);

    second.abort("cancelled-by-second");
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("cancelled-by-second");
  });

  test("aborts immediately for an already-aborted signal", () => {
    const already = new AbortController();
    already.abort("already-aborted");
    const combined = anyAbortSignal([new AbortController().signal, already.signal]);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("already-aborted");
  });

  test("only fills a missing implementation", () => {
    const missing: { any?: unknown } = {};
    installAbortSignalAnyPolyfill(missing);
    expect(typeof missing.any).toBe("function");

    const native = () => new AbortController().signal;
    const existing: { any?: unknown } = { any: native };
    installAbortSignalAnyPolyfill(existing);
    expect(existing.any).toBe(native);
  });
});

describe("crypto.randomUUID compatibility", () => {
  test("uses getRandomValues when randomUUID is missing or unavailable", () => {
    expect(randomUuid(fakeCrypto())).toMatch(UUID_V4);
    expect(randomUuid({
      ...fakeCrypto(),
      randomUUID() {
        throw new TypeError("randomUUID is not available in this context");
      },
    })).toMatch(UUID_V4);
  });

  test("only fills a missing implementation", () => {
    const native = () => "11111111-1111-4111-8111-111111111111";
    const existing = { ...fakeCrypto(), randomUUID: native };
    installRandomUuidPolyfill(existing);
    expect(existing.randomUUID()).toBe("11111111-1111-4111-8111-111111111111");

    const missing = fakeCrypto() as ReturnType<typeof fakeCrypto> & { randomUUID?: () => string };
    installRandomUuidPolyfill(missing);
    expect(typeof missing.randomUUID).toBe("function");
    expect(missing.randomUUID!()).toMatch(UUID_V4);
  });
});

test("the combined installer is idempotent", () => {
  expect(() => {
    installBrowserCompatPolyfills();
    installBrowserCompatPolyfills();
  }).not.toThrow();
});

test("the browser compatibility entrypoint has no Node or server dependencies", async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./browser_compat.ts", import.meta.url))],
    target: "browser",
    metafile: true,
  });
  expect(build.success).toBe(true);
  const graph = build.metafile;
  if (graph === undefined) throw new Error("Missing browser compatibility dependency graph");
  const inputs = Object.keys(graph.inputs);
  expect(inputs.some((path) => path.endsWith("browser_compat.ts"))).toBe(true);
  expect(inputs.some((path) => path.includes("node:async_hooks"))).toBe(false);
  expect(inputs.some((path) => /angular|rxjs|compiler/.test(path))).toBe(false);
  const exports = Object.values(graph.outputs).flatMap((output) => output.exports);
  expect(exports).toContain("installBrowserCompatPolyfills");
});