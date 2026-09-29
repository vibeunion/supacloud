import { test, expect } from "bun:test";

// A worker must not import the application metadata entry point as a side effect.
test("portable execution entry bundles without Elysia, Angular or schema runtimes", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("./execution.ts", import.meta.url).pathname],
    target: "browser",
    minify: false,
  });
  expect(result.success).toBe(true);
  const output = (await Promise.all(result.outputs.map(file => file.text()))).join("\n");
  for (const dependency of ["node_modules/elysia", "node_modules/@angular", "node_modules/typebox", "reflect-metadata"]) {
    expect(output).not.toContain(dependency);
  }
  expect(output).toContain("createCommandPipeline");
  expect(output).toContain("composeExecution");
});
