import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the browser contracts entry bundles without the app root or framework dependencies", async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./contract_client.ts", import.meta.url))],
    target: "browser",
    metafile: true,
  });
  expect(build.success).toBe(true);
  const graph = build.metafile;
  if (graph === undefined) throw new Error("Missing contract bundle dependency graph");
  const inputs = Object.keys(graph.inputs);
  expect(inputs.some((path) => path.endsWith("contract_client.ts"))).toBe(true);
  expect(inputs.some((path) => /angular|rxjs|compiler/.test(path))).toBe(false);
  expect(inputs.some((path) => path.endsWith("packages/app/src/index.ts"))).toBe(false);
  const exports = Object.values(graph.outputs).flatMap((output) => output.exports);
  expect(exports).toContain("createContractCommandClient");
  expect(exports).toContain("createAuthoritativeCommandClient");
});
