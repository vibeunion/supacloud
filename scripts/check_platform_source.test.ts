import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { scanPlatformSource } from "./check_platform_source";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("platform source scan rejects explicit any and line-comment type suppressions", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-platform-source-"));
  roots.push(root);
  await mkdir(join(root, "packages/example/src"), { recursive: true });
  await writeFile(join(root, "packages/example/src/index.ts"), "export const value: any = 1;\n// @ts-ignore\n");
  expect(scanPlatformSource(root)).toEqual([
    expect.objectContaining({ kind: "explicit-any", line: 1 }),
    expect.objectContaining({ kind: "type-suppression", line: 2 }),
  ]);
});

test("platform source scan covers Svelte scripts and excludes tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-platform-source-"));
  roots.push(root);
  await mkdir(join(root, "packages/example/src"), { recursive: true });
  await writeFile(join(root, "packages/example/src/page.svelte"), '<script lang="ts">const value: any = 1;</script>');
  await writeFile(join(root, "packages/example/src/page.test.ts"), "const value: any = 1;");
  expect(scanPlatformSource(root)).toEqual([
    expect.objectContaining({ file: "packages/example/src/page.svelte", kind: "explicit-any" }),
  ]);
});

test("platform source scan covers Svelte snippet types and template expressions", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-platform-source-"));
  roots.push(root);
  await mkdir(join(root, "packages/example/src"), { recursive: true });
  await writeFile(join(root, "packages/example/src/page.svelte"),
    '<script lang="ts"></script>{#snippet cell({ value }: { value: any })}{value as any}{/snippet}');
  expect(scanPlatformSource(root).map((finding) => finding.kind)).toEqual(["explicit-any", "explicit-any"]);
});

test("type-suppression prose inside a string is not a directive", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-platform-source-"));
  roots.push(root);
  await mkdir(join(root, "packages/example/src"), { recursive: true });
  await writeFile(join(root, "packages/example/src/index.ts"), 'export const note = "// @ts-ignore";');
  expect(scanPlatformSource(root)).toEqual([]);
});

test("platform source scan permits negative assertions in typecheck fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-platform-source-"));
  roots.push(root);
  await mkdir(join(root, "packages/example/src"), { recursive: true });
  await writeFile(join(root, "packages/example/src/contract.typecheck.ts"), "// @ts-expect-error\nconst value = 1;");
  expect(scanPlatformSource(root)).toEqual([]);
});

test("typecheck fixtures cannot disable checking or declare any", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-platform-source-"));
  roots.push(root);
  await mkdir(join(root, "packages/example/src"), { recursive: true });
  await writeFile(join(root, "packages/example/src/contract.typecheck.ts"),
    "// @ts-nocheck\nconst value: any = 1;\n// @ts-ignore\nvalue();");
  expect(scanPlatformSource(root).map((finding) => finding.kind)).toEqual([
    "type-suppression", "explicit-any", "type-suppression",
  ]);
});
