import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FunctionBytecodeCache } from "./function-bytecode";
import { functionBytecodeMode } from "./function-bytecode-contract";
import { parseEdgeFunctionActivationManifest } from "./function-activation";

const fixtures: Array<{ root: string; cache: FunctionBytecodeCache }> = [];
const digest = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

async function fixture(source = 'export default { fetch() { return new Response("ok"); } };') {
  const root = await realpath(await mkdtemp(join(homedir(), ".supacloud-bytecode-test-")));
  const functionPath = join(root, "index.js");
  await writeFile(functionPath, source, { mode: 0o600 });
  const cache = new FunctionBytecodeCache();
  fixtures.push({ root, cache });
  return {
    root, source, cache,
    request: { functionPath, projectRoot: root, artifactSha256: digest(source), bytecode: "auto" as const },
  };
}

afterEach(async () => {
  for (const { root, cache } of fixtures.splice(0)) {
    await cache.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("mode defaults off, preserves all supported modes, and rejects invalid values", () => {
  expect(functionBytecodeMode(undefined)).toBe("off");
  for (const bytecode of ["off", "auto", "required"] as const) {
    expect(parseEdgeFunctionActivationManifest(JSON.stringify({ bytecode })).config.bytecode).toBe(bytecode);
  }
  for (const bytecode of [null, true, "enabled", {}, 1]) {
    expect(() => parseEdgeFunctionActivationManifest(JSON.stringify({ bytecode }))).toThrow("bytecode mode");
  }
});

test("off and request cache misses never compile or write", async () => {
  const { cache, request, root } = await fixture();
  expect(await cache.prepare({ ...request, bytecode: "off" })).toBeUndefined();
  expect(cache.lookup(request)).toBeUndefined();
  expect(() => cache.lookup({ ...request, bytecode: "required" })).toThrow("preheat");
  expect(cache.metrics.builds).toBe(0);
  expect(await readdir(root)).toEqual(["index.js"]);
});

test("preheat builds a paired artifact once, without modifying published JS or evaluating tenant code", async () => {
  const { cache, request, source } = await fixture('export default { fetch() { return new Response("ok"); } };');
  const [a, b] = await Promise.all([cache.prepare(request), cache.prepare(request)]);
  expect(a).toBeDefined();
  expect(a).toEqual(b);
  if (!a) throw new Error("Expected a generated pair");
  expect(cache.metrics.builds).toBe(1);
  expect(a.sourceSha256).toBe(request.artifactSha256);
  expect(digest(await readFile(a.path))).toBe(a.sha256);
  expect(digest(await readFile(`${a.path}.jsc`))).toBe(a.bytecodeSha256);
  expect(await readFile(request.functionPath, "utf8")).toBe(source);
  expect(cache.lookup({ ...request, bytecode: "required" })).toEqual(a);
  const runner = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e",
      `const m = await import(${JSON.stringify(a.path)}); console.log(await m.default.fetch().text())`],
    env: { PATH: process.env.PATH, BUN_JSC_verboseDiskCache: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(runner.exitCode).toBe(0);
  expect(runner.stdout.toString().trim()).toBe("ok");
  expect(runner.stderr.toString()).toContain("Cache hit for sourceCode");
});

test("host build does not execute tenant module side effects", async () => {
  const { cache, request } = await fixture('throw new Error("must not execute at build time"); export default () => new Response("ok");');
  expect(await cache.prepare(request)).toBeDefined();
});

test("derived imports preserve environment-version cache isolation", async () => {
  const { cache, request } = await fixture('const value = process.env.BYTECODE_TEST; export default () => new Response(value);');
  const artifact = await cache.prepare(request);
  if (!artifact) throw new Error("Expected a generated pair");
  const runner = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", `
      process.env.BYTECODE_TEST = "first";
      const a = await import(${JSON.stringify(artifact.path)} + "?env=first");
      process.env.BYTECODE_TEST = "second";
      const b = await import(${JSON.stringify(artifact.path)} + "?env=second");
      console.log(await a.default().text(), await b.default().text());
    `],
    env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
  });
  expect(runner.exitCode).toBe(0);
  expect(runner.stdout.toString().trim()).toBe("first second");
});

test("auto falls back and required rejects unsupported top-level await and asset paths", async () => {
  for (const source of [
    'await Promise.resolve(); export default () => new Response("ok");',
    'export default () => new Response(import.meta.dir);',
    'export default () => new Response(import/* comment */.meta.dir);',
    'export default () => new Response(import. /* comment */ meta.url);',
    'export default () => new Response(__dir\\u006eame);',
    'export default async () => { const name = "node:crypto"; return import(name); };',
    'import value from "./asset.json"; export default () => Response.json(value);',
  ]) {
    const { cache, request, root } = await fixture(source);
    expect(await cache.prepare(request)).toBeUndefined();
    await expect(cache.prepare({ ...request, bytecode: "required" })).rejects.toThrow("preparation failed");
    expect(await readdir(root)).toEqual(["index.js"]);
  }
});

test("source digest and tenant path partition the cache; no client sidecar is reused", async () => {
  const a = await fixture();
  const b = await fixture();
  await writeFile(`${a.request.functionPath}.jsc`, "untrusted");
  expect(await a.cache.prepare({ ...a.request, artifactSha256: "0".repeat(64) })).toBeUndefined();
  const artifact = await a.cache.prepare(a.request);
  expect(artifact).toBeDefined();
  expect(a.cache.lookup(b.request)).toBeUndefined();
  expect(a.cache.lookup({ ...a.request, artifactSha256: "1".repeat(64) })).toBeUndefined();
  expect(a.cache.metrics.builds).toBe(1);
  await chmod(a.request.functionPath, 0o600);
  await writeFile(a.request.functionPath, "changed");
  expect(await a.cache.prepare({ ...a.request, artifactSha256: "2".repeat(64) })).toBeUndefined();
});


test("preheat never executes builtin macros or legacy import assertions in the host", async () => {
  for (const attribute of [
    'with { type: "macro" }',
    'assert { type: "macro" }',
    'with { "type": "ma\\u0063ro" }',
  ]) {
    const { root, cache, request } = await fixture();
    const marker = join(root, "host-marker");
    await writeFile(marker, "untouched");
    const source = `import { writeFileSync } from "node:fs" ${attribute};
      writeFileSync(${JSON.stringify(marker)}, "host code executed");
      export default () => new Response("ok");`;
    await writeFile(request.functionPath, source);
    const input = { ...request, artifactSha256: digest(source) };
    expect(await cache.prepare(input)).toBeUndefined();
    await expect(cache.prepare({ ...input, bytecode: "required" })).rejects.toThrow("preparation failed");
    expect(await readFile(marker, "utf8")).toBe("untouched");
    expect(cache.metrics.builds).toBe(0);
  }
});

test("preheat rejects sources outside the project and symlinked sources before writing a cache", async () => {
  const a = await fixture();
  const b = await fixture();
  expect(await a.cache.prepare({ ...a.request, functionPath: b.request.functionPath })).toBeUndefined();
  const alias = join(a.root, "alias.js");
  await symlink(b.request.functionPath, alias);
  expect(await a.cache.prepare({ ...a.request, functionPath: alias })).toBeUndefined();
  expect(a.cache.metrics.builds).toBe(0);
  expect((await readdir(a.root)).sort()).toEqual(["alias.js", "index.js"]);
});

test("oversized sources are rejected before compilation and allocation of source contents", async () => {
  const { cache, request, root } = await fixture();
  await truncate(request.functionPath, 128 * 1024 * 1024);
  expect(await cache.prepare(request)).toBeUndefined();
  await expect(cache.prepare({ ...request, bytecode: "required" })).rejects.toThrow("preparation failed");
  expect(cache.metrics.builds).toBe(0);
  expect(await readdir(root)).toEqual(["index.js"]);
});

test("disposed caches cannot serve a required artifact", async () => {
  const { cache, request } = await fixture();
  expect(await cache.prepare(request)).toBeDefined();
  await cache.dispose();
  expect(cache.lookup(request)).toBeUndefined();
  expect(() => cache.lookup({ ...request, bytecode: "required" })).toThrow("preheat");
  await expect(cache.prepare({ ...request, bytecode: "required" })).rejects.toThrow("preparation failed");
});


test("safe builtin imports remain eligible without enabling compiler macros", async () => {
  const { cache, request } = await fixture('import { basename } from "node:path"; export default () => new Response(basename("/one/two"));');
  const artifact = await cache.prepare({ ...request, bytecode: "required" });
  expect(artifact).toBeDefined();
  const handler = (await import(artifact!.path)).default;
  expect(await handler().text()).toBe("two");
});
