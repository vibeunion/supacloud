import { expect, test } from "bun:test";
import { join } from "node:path";

async function bundle(entry: string, external: string[] = []) {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, entry)],
    target: "node",
    external,
    format: "esm",
  });
  expect(result.success).toBe(true);
  return (await Promise.all(result.outputs.map((item) => item.text()))).join("\n");
}

const angularFree = [
  "index.ts",
  "core.ts",
  "execution.ts",
  "contract_client.ts",
  "browser.ts",
  "browser_compat.ts",
  "reactive.ts",
  "http.ts",
  "pending-work.ts",
];

test("non-runtime entries do not import @angular/core", async () => {
  for (const entry of angularFree) {
    const output = await bundle(entry);
    expect({ entry, leaked: output.includes("@angular/core") }).toEqual({ entry, leaked: false });
  }
});

test("the runtime export is the inject-based Angular adapter", async () => {
  const output = await bundle("runtime.ts", ["@angular/core", "@angular/core/rxjs-interop", "rxjs"]);
  expect(output).toContain("@angular/core");
  expect(output).toContain("provideHttpClient");
  const browser = await Bun.build({
    entrypoints: [join(import.meta.dir, "angular.ts"), join(import.meta.dir, "rxjs.ts")],
    target: "browser",
    external: ["@angular/core", "@angular/core/rxjs-interop", "rxjs"],
    format: "esm",
  });
  expect(browser.success).toBe(true);
  const browserText = (await Promise.all(browser.outputs.map((item) => item.text()))).join("\n");
  expect(browserText).toContain("@angular/core");
  expect(browserText).not.toContain("node:async_hooks");
});
