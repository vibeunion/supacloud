import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { HttpClient } from "./browser";

test("the browser app entry bundles without Node or server DI dependencies", async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./browser.ts", import.meta.url))],
    target: "browser",
    metafile: true,
  });
  expect(build.success).toBe(true);
  const graph = build.metafile;
  if (graph === undefined) throw new Error("Missing browser bundle dependency graph");
  const inputs = Object.keys(graph.inputs);
  expect(inputs.some((path) => path.endsWith("browser.ts"))).toBe(true);
  expect(inputs.some((path) => path.includes("node:async_hooks"))).toBe(false);
  expect(inputs.some((path) => path.endsWith("packages/app/src/inject.ts"))).toBe(false);
  expect(inputs.some((path) => /angular|rxjs|compiler/.test(path))).toBe(false);
  const exports = Object.values(graph.outputs).flatMap((output) => output.exports);
  expect(exports).toContain("HttpClient");
  expect(exports).toContain("HttpContractError");
});

test("the browser HttpClient keeps the fetch and contract execution surface", async () => {
  const client = new HttpClient({
    fetch: (async (input, init) => new Response(JSON.stringify({
      method: init?.method,
      url: String(input),
    }), { headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  const result = await client.execute({
    input: (value: unknown) => value as { id: string },
    request: (value) => ({ method: "POST", url: "/items", body: value }),
    result: (value: unknown) => value as { method: string; url: string },
  }, { id: "item-1" });
  expect(result).toEqual({ method: "POST", url: "/items" });
});
