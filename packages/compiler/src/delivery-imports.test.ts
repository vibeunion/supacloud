import { expect, test } from "bun:test";
import { staticDeliveryImports } from "./delivery-imports";
import { bundleDeliveryTarget } from "./delivery-bundle";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureProject } from "./fixtures/helpers";

const convert = (source: string) => new TextDecoder().decode(
  staticDeliveryImports("/fixture/entry.js", new TextEncoder().encode(source)),
);
const wrapper = "function load(specifier) { return import(specifier); }";

test("expands private import helpers only when every reference is a literal call", () => {
  const output = convert(`${wrapper}
    export async function run() { return Promise.all([load("node:fs/promises"), load("strtok3")]); }
  `);
  expect(output).toContain('import("node:fs/promises")');
  expect(output).toContain('import("strtok3")');
  expect(output).not.toContain("function load");
  expect(output).not.toContain("import(specifier)");
});

test("rejects escaped, exported, reassigned, side-effecting and open import helpers", () => {
  for (const source of [
    `${wrapper} export const run = load;`,
    `${wrapper} export const object = { load };`,
    `${wrapper} export { load };`,
    `${wrapper} export { load as run };`,
    `${wrapper} export const run = () => load(process.env.MODULE);`,
    `${wrapper} export const run = () => load(...["node:fs"]);`,
    `${wrapper} load = () => {}; export const run = () => load("node:fs");`,
    `export ${wrapper} export const run = () => load("node:fs");`,
    `async ${wrapper} export const run = () => load("node:fs");`,
    `function load(specifier) { console.log(specifier); return import(specifier); }
      export const run = () => load("node:fs");`,
    `function load(specifier = "node:fs") { return import(specifier); }
      export const run = () => load("node:fs");`,
    `function load(specifier) { return require(specifier); }
      export const run = () => load("node:fs");`,
    `${wrapper} export const run = () => load("node:fs"); export const other = () => import(process.env.MODULE);`,
    `${wrapper} load("node:fs");`,
  ]) expect(() => convert(source)).toThrow("Computed module loading");
});

test("does not rewrite shadowed bindings and preserves files without computed imports", () => {
  const source = 'export const run = () => import("node:path");';
  expect(convert(source)).toBe(source);
  const output = convert(`${wrapper}
    export const run = () => load("node:fs");
    export function another(load) { return load("unrelated"); }
  `);
  expect(output).toContain('import("node:fs")');
  expect(output).toContain('load("unrelated")');
});

test("literal helper dependencies are bundled and captured before source removal", async () => {
  const project = await mkdtemp(join(tmpdir(), "delivery-imports-"));
  const detached = await mkdtemp(join(tmpdir(), "delivery-imports-detached-"));
  try {
    await writeFixtureProject(project, {
      "entry.js": `${wrapper} export const run = () => load("./dependency.js");`,
      "dependency.js": 'export const value = "bundled-dependency";',
    });
    const bundles = [];
    for (const minify of [false, true]) {
      const result = await bundleDeliveryTarget("api", 'export {run} from "./entry.js";', project, project, {
        version: 1, build: {minify},
      });
      expect(result.inputs.has(await realpath(join(project, "dependency.js")))).toBe(true);
      const output = result.files.get("bundle/index.js");
      if (!output) throw new Error("Missing bundle");
      const name = `${minify}.js`;
      await writeFixtureProject(detached, { [name]: new TextDecoder().decode(output) });
      bundles.push(join(detached, name));
    }
    await rm(project, { recursive: true, force: true });
    for (const path of bundles) {
      const app = await import(path);
      expect(await app.run()).toMatchObject({ value: "bundled-dependency" });
    }
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(detached, { recursive: true, force: true });
  }
});
