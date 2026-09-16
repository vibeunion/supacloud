import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateProject, migrateRouteResponse } from "./migrations";

test("migrates deprecated route response schemas to an explicit 200 response map", () => {
  const source = `
const Result = {};
@Get("/items", { response: Result })
class ItemsController {}
const unrelated = { response: Result };
`;
  const result = migrateRouteResponse(source, "src/items.ts");
  expect(result.issues).toEqual([]);
  expect(result.replacements).toBe(1);
  expect(result.content).toContain('responses: { 200: Result }');
  expect(result.content).toContain("const unrelated = { response: Result }");
});

test("migrates route options resolved through a local const and defineRouteContract", () => {
  const result = migrateRouteResponse(`
const defineRouteContract = <T>(value: T): T => value;
const routeOptions = defineRouteContract({ response: Result });
@Get("/items", routeOptions)
class ItemsController {}
`, "src/items.ts");
  expect(result.issues).toEqual([]);
  expect(result.replacements).toBe(1);
  expect(result.content).toContain("const routeOptions = defineRouteContract({ responses: { 200: Result } });");
});

test("does not guess when a route already has a response map", () => {
  const result = migrateRouteResponse(
    `@Get("/items", { response: Legacy, responses: { 201: Created } }) class ItemsController {}`,
    "src/items.ts",
  );
  expect(result.changed).toBe(false);
  expect(result.issues).toMatchObject([{ code: "route-response-conflict", file: "src/items.ts", line: 1 }]);
});

test("project migration is atomic when one file needs manual conflict resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-migration-"));
  await mkdir(join(root, "src"), { recursive: true });
  const goodPath = join(root, "src/good.ts");
  const conflictPath = join(root, "src/conflict.ts");
  const good = `@Get("/good", { response: Result }) class GoodController {}`;
  const conflict = `@Get("/conflict", { response: Legacy, responses: { 201: Created } }) class ConflictController {}`;
  await writeFile(goodPath, good, "utf8");
  await writeFile(conflictPath, conflict, "utf8");

  const result = await migrateProject({ rootDir: root, write: true });
  expect(result.issues).toHaveLength(1);
  expect(result.changedFiles).toEqual([]);
  expect(await readFile(goodPath, "utf8")).toBe(good);
  expect(await readFile(conflictPath, "utf8")).toBe(conflict);
  await rm(root, { recursive: true, force: true });
});

test("project migration follows route contracts across files and only changes the declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-migration-cross-file-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    const controllerPath = join(root, "src/controller.ts");
    const contractPath = join(root, "src/contracts.ts");
    await writeFile(controllerPath, `
import { Get } from "@supacloud/app";
import { ItemsRoute } from "./contracts";
@Get("/items", ItemsRoute)
class ItemsController {}
`, "utf8");
    await writeFile(contractPath, `
const defineRouteContract = <T>(value: T): T => value;
const Result = {};
export const ItemsRoute = defineRouteContract({ response: Result });
`, "utf8");

    const preview = await migrateProject({ rootDir: root });
    expect(preview.issues).toEqual([]);
    expect(preview.changedFiles).toEqual(["src/contracts.ts"]);
    expect(preview.files).toMatchObject([{ file: "src/contracts.ts", replacements: 1 }]);

    const applied = await migrateProject({ rootDir: root, write: true });
    expect(applied.issues).toEqual([]);
    expect(applied.changedFiles).toEqual(["src/contracts.ts"]);
    expect(await readFile(controllerPath, "utf8")).toContain("@Get(\"/items\", ItemsRoute)");
    expect(await readFile(contractPath, "utf8")).toContain("responses: { 200: Result }");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project migration uses tsconfig path aliases when resolving shared contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-migration-paths-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "ESNext", moduleResolution: "Bundler", baseUrl: ".", paths: { "@contracts/*": ["src/*"] } },
    }), "utf8");
    await writeFile(join(root, "src/controller.ts"), `
import { Get } from "@supacloud/app";
import { ItemsRoute } from "@contracts/contracts";
@Get("/items", ItemsRoute)
class ItemsController {}
`, "utf8");
    await writeFile(join(root, "src/contracts.ts"), `
export const ItemsRoute = { response: Result };
`, "utf8");

    const result = await migrateProject({ rootDir: root });
    expect(result.issues).toEqual([]);
    expect(result.changedFiles).toEqual(["src/contracts.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
