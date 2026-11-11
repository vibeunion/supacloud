import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

test("the pending-work subpath publishes a runtime JavaScript entry", async () => {
  const manifest = record(readJson(join(packageRoot, "package.json")), "package.json");
  const exportsMap = record(manifest["exports"], "exports");
  const pendingWork = record(exportsMap["./pending-work"], "exports['./pending-work']");
  expect(pendingWork).toEqual({
    types: "./dist/pending-work.d.ts",
    import: "./dist/pending-work.js",
    default: "./dist/pending-work.js",
  });
  const files = manifest["files"];
  expect(Array.isArray(files) && files.includes("dist")).toBe(true);
  const scripts = record(manifest["scripts"], "scripts");
  expect(scripts["build:js"]).toContain("src/pending-work.ts");
  const tsconfig = record(readJson(join(packageRoot, "tsconfig.json")), "tsconfig.json");
  const include = tsconfig["include"];
  expect(Array.isArray(include) && include.includes("src/pending-work.ts")).toBe(true);

  const built = await Bun.build({
    entrypoints: [join(packageRoot, "src/pending-work.ts")],
    target: "browser",
    format: "esm",
  });
  expect(built.success).toBe(true);
  const source = (await Promise.all(built.outputs.map((output) => output.text()))).join("\n");
  expect(source).toContain("PendingWorkRegistry");
  expect(source).not.toContain("@angular/core");
});
