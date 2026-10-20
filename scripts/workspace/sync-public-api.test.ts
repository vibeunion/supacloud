import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { collectPublicApi, compareSnapshot, type PublicApiSnapshot } from "../check_public_api";
import { applySyncPlan, syncPlan } from "./sync.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "supacloud-api-sync-"));
  roots.push(root);
  const source = resolve(root, "index.ts");
  const snapshot = resolve(root, "public-api.json");
  writeFileSync(resolve(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ["index.ts"] }));
  writeFileSync(source, "export interface PublicRecord { id: string; }\n");
  const original: PublicApiSnapshot = { format: 2, package: "@test/sync", entrypoint: ".", exports: [] };
  writeFileSync(snapshot, `${JSON.stringify(original, null, 2)}\n`);
  const generate = async () => {
    const actual = await collectPublicApi({ packageName: "@test/sync", source, snapshot });
    return [{ file: "public-api.json", content: `${JSON.stringify(actual, null, 2)}\n`, summary: compareSnapshot(original, actual) }];
  };
  return { root, source, snapshot, generate };
}

test("sync uses the real exported public API collector and preserves its snapshot format", async () => {
  expect(typeof collectPublicApi).toBe("function"); expect(typeof compareSnapshot).toBe("function");
  const f = fixture(), before = readFileSync(f.snapshot, "utf8");
  const outputs = await f.generate(), plan = syncPlan(f.root, outputs);
  expect(plan.clean).toBe(false);
  expect(outputs[0]!.summary).toContain("added PublicRecord (type)");
  expect(readFileSync(f.snapshot, "utf8")).toBe(before);
  expect(applySyncPlan(f.root, plan, outputs).clean).toBe(true);
  expect(JSON.parse(readFileSync(f.snapshot, "utf8")).format).toBe(2);
  expect(applySyncPlan(f.root, syncPlan(f.root, await f.generate()), await f.generate()).applied).toEqual([]);
});

test("a public declaration change invalidates the reviewed plan without changing its destination", async () => {
  const f = fixture(), before = readFileSync(f.snapshot, "utf8");
  const plan = syncPlan(f.root, await f.generate());
  writeFileSync(f.source, "export interface PublicRecord { id: number; }\n");
  const changed = await f.generate();
  expect(() => applySyncPlan(f.root, plan, changed)).toThrow("Stale sync plan");
  expect(readFileSync(f.snapshot, "utf8")).toBe(before);
});

test("the public API collector rejects wildcard exports before any snapshot write", async () => {
  const f = fixture(), before = readFileSync(f.snapshot, "utf8");
  writeFileSync(f.source, "export * from './another';\n");
  writeFileSync(resolve(f.root, "another.ts"), "export const x = 1;\n");
  await expect(f.generate()).rejects.toThrow("explicit exports");
  expect(readFileSync(f.snapshot, "utf8")).toBe(before);
});

for (const [name, source] of [
  ["missing type declaration", "export type { Missing } from './missing';\n"],
  ["missing value declaration", "export { Missing } from './missing';\n"],
  ["transitive unresolved alias", "export { Missing } from './relay';\n"],
  ["missing named export", "export { Missing } from './present';\n"],
  ["uninstalled dependency", "export type { Missing } from '@fixture/not-installed';\n"],
] as const) {
  test(`the public API collector rejects ${name} without replacing the snapshot`, async () => {
    const f = fixture(), before = readFileSync(f.snapshot, "utf8");
    writeFileSync(resolve(f.root, "relay.ts"), "export { Missing } from './missing';\n");
    writeFileSync(resolve(f.root, "present.ts"), "export const Present = 1;\n");
    writeFileSync(f.source, source);
    await expect(f.generate()).rejects.toThrow("Cannot resolve public API export Missing");
    expect(readFileSync(f.snapshot, "utf8")).toBe(before);
  });
}

test("resolved renamed type and value exports retain nonempty signatures and kinds", async () => {
  const f = fixture();
  writeFileSync(resolve(f.root, "present.ts"), [
    "export interface Original { id: string; }",
    'export class Value { readonly id = "id"; }',
    "export function read(id: string): string { return id; }",
  ].join("\n"));
  writeFileSync(f.source, "export type { Original as PublicRecord } from './present';\nexport { Value, read as lookup } from './present';\n");
  const actual = await collectPublicApi({ packageName: "@test/sync", source: f.source, snapshot: f.snapshot });
  expect(Object.fromEntries(actual.exports.map(item => [item.name, item.kind])))
    .toEqual({ lookup: "value", PublicRecord: "type", Value: "both" });
  expect(actual.exports.every(item => item.signature.length > 0)).toBe(true);
});

test("the public API collector recovers after missing declarations are built", async () => {
  const f = fixture(), before = readFileSync(f.snapshot, "utf8");
  writeFileSync(f.source, "export type { Missing } from './missing';\n");
  await expect(f.generate()).rejects.toThrow("Cannot resolve public API export Missing");
  writeFileSync(resolve(f.root, "missing.ts"), "export interface Missing { id: string; }\n");
  const actual = await collectPublicApi({ packageName: "@test/sync", source: f.source, snapshot: f.snapshot });
  expect(actual.exports[0]?.kind).toBe("type");
  expect(actual.exports[0]?.signature).toContain("id: string");
  expect(readFileSync(f.snapshot, "utf8")).toBe(before);
});
