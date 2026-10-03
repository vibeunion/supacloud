import { expect, test } from "bun:test";
import { join } from "node:path";
import * as core from "./core";
import { Module } from "./decorators";
import { InjectionToken } from "./token";
import metadata from "../package.json";

test("core preserves metadata identities without exporting frontend framework APIs", () => {
  expect(core.Module).toBe(Module);
  expect(core.InjectionToken).toBe(InjectionToken);
  for (const name of ["Forms", "FormControl", "signal", "resource", "HttpClient",
    "provideRouter", "TestBed", "bootstrapBun", "TransferState", "DatePipe"]) {
    expect(Object.hasOwn(core, name)).toBe(false);
  }
  expect(metadata.exports["./core"].import).toBe("./dist/core.js");
  expect(metadata.scripts["build:js"]).toContain("src/core.ts");
});

test("core bundle never traverses UI, reactive, transport or runtime implementations", async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "core.ts")],
    target: "browser",
    external: ["@angular/core"],
    metafile: true,
  });
  expect(result.success).toBe(true);
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  expect(inputs.length).toBeGreaterThan(0);
  for (const name of ["forms.ts", "signal.ts", "resource.ts", "http_client.ts",
    "route_provider.ts", "inject.ts", "bun.ts", "testing.ts"]) {
    expect(inputs.some(path => path.endsWith(`/${name}`))).toBe(false);
  }
});
