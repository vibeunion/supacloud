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

test("package root and core do not import @angular/core", async () => {
  for (const entry of ["index.ts", "core.ts"]) {
    const output = await bundle(entry);
    expect(output).not.toContain("@angular/core");
    expect(output).not.toContain("@supacloud/app/runtime");
  }
});

test("the runtime export is the only Angular injector adapter", async () => {
  const output = await bundle("runtime.ts", ["@angular/core", "@angular/core/rxjs-interop", "rxjs"]);
  expect(output).toContain("@angular/core");
  const pending = await bundle("pending-work.ts");
  expect(pending).not.toContain("@angular/core");
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
