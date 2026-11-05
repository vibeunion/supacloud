import * as ts from "../../packages/db/src/typescript.ts";
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { readWorkspace } from './model.mjs';
import { checkSourceBoundaries, effectRuntimeExecutionSites, importSites } from './source.mjs';
function fixture(t, source) {
  const root = mkdtempSync(resolve(tmpdir(), 'supacloud-source-hardening-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  for (const name of ['client', 'public', 'secret']) {
    put(`packages/${name}/package.json`, { name: `@test/${name}`, exports: { '.': './src/index.ts' }, dependencies: name === 'client' ? { '@test/public': 'file:../public' } : {} });
    put(`packages/${name}/project.json`, { name: `@test/${name}`, tags: ['scope:test', `type:${name}`] });
    put(`packages/${name}/src/index.ts`, name === 'client' ? source : 'export const value = 1;');
  }
  return { root, put, check: async () => (await checkSourceBoundaries(readWorkspace(root), ts, [{ sourceTag: 'type:client', bannedDependenciesWithTags: ['type:secret'] }])) };
}

for (const specifier of ['@test/public', '@test/client']) {
  test(`named or self package aliases cannot hide a forbidden actual owner: ${specifier}`, async (t) => {
    const { put, check } = fixture(t, `import {value} from '${specifier}';`);
    put('packages/client/tsconfig.json', { compilerOptions: { baseUrl: '.', paths: { [specifier]: ['../secret/src/index.ts'] } } });
    const report = (await check());
    assert.ok(report.edges.some((edge) => edge.target === '@test/secret'));
    assert.ok(report.diagnostics.some((entry) => entry.code === 'WS_BOUNDARY_VIOLATION'));
    assert.ok(report.diagnostics.some((entry) => entry.code === 'WS_PRIVATE_IMPORT'));
    assert.ok(report.diagnostics.some((entry) => entry.code === 'WS_UNDECLARED_IMPORT'));
  });
}

test('missing alias outputs are unverified, not silently clean', async (t) => {
  const { put, check } = fixture(t, "import {value} from '@hidden/missing';");
  put('packages/client/tsconfig.json', { compilerOptions: { paths: { '@hidden/*': ['../secret/dist/*.js'] } } });
  assert.ok((await check()).notes.some((entry) => entry.code === 'WS_UNRESOLVED_ALIAS'));
});

test('self package imports must still use public subpaths', async (t) => {
  const { check } = fixture(t, "import '@test/client/private';");
  assert.ok((await check()).diagnostics.some((entry) => entry.code === 'WS_PRIVATE_IMPORT'));
});

test('require aliases and import.meta.resolve contribute module references', async () => {
  const source = (await ts.createSourceFile('x.mts', `import {createRequire as makeRequire} from 'node:module';
    const fromHere = makeRequire(import.meta.url);
    fromHere('@test/secret'); fromHere.resolve('@test/secret/private');
    import.meta.resolve('@test/public'); fromHere(variable);`, ts.ScriptTarget.Latest, true));
  assert.deepEqual((await importSites(ts, source)).map((site) => site.specifier), ['node:module', '@test/secret', '@test/secret/private', '@test/public', null]);
});

test('handwritten declaration imports are checked', async (t) => {
  const { put, check } = fixture(t, 'export {};');
  put('packages/client/src/types.d.ts', "export type T = import('@test/secret').T;");
  assert.ok((await check()).diagnostics.some((entry) => entry.file.endsWith('types.d.ts') && entry.code === 'WS_BOUNDARY_VIOLATION'));
});

test('skipped source symlinks are explicit coverage findings', async (t) => {
  const { root, check } = fixture(t, 'export {};');
  symlinkSync(resolve(root, 'packages/secret/src/index.ts'), resolve(root, 'packages/client/src/linked.ts'));
  assert.ok((await check()).notes.some((entry) => entry.code === 'WS_SOURCE_SYMLINK'));
});

test('fingerprints survive line changes, but not changed import symbols or destinations', async () => {
  const sites = async (text) => (await importSites(ts, (await ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true))));
  const hash = (await sites("import {value} from '@test/secret';"))[0].fingerprint;
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal((await sites("// new comment\n\nimport { value } from '@test/secret';"))[0].fingerprint, hash);
  assert.notEqual((await sites("import {other} from '@test/secret';"))[0].fingerprint, hash);
});

test('installed dependency copies are not mistaken for the importing project', async (t) => {
  const { put, check } = fixture(t, "import {value} from '@test/secret';");
  put('packages/client/node_modules/@test/secret/package.json', { name: '@test/secret', exports: { '.': './index.js' } });
  put('packages/client/node_modules/@test/secret/index.js', 'export const value = 1;');
  assert.ok((await check()).diagnostics.some((entry) => entry.code === 'WS_BOUNDARY_VIOLATION'));
});

test('direct Effect runtime execution is a production source boundary violation', async (t) => {
  const { check } = fixture(t, `import { Effect } from 'effect';\nEffect.runPromise(Effect.succeed(1));`);
  const report = (await check());
  assert.ok(report.diagnostics.some((entry) =>
    entry.code === 'WS_EFFECT_RUNTIME_ESCAPE' && entry.file === 'packages/client/src/index.ts'));
});

test('the Elysia adapter is the only allowlisted production Effect interpreter', async (t) => {
  const { check, put } = fixture(t, 'export {};');
  put('packages/elysia/package.json', { name: '@test/elysia', exports: { '.': './src/index.ts' } });
  put('packages/elysia/project.json', { name: '@test/elysia', tags: ['scope:test', 'type:framework'] });
  put('packages/elysia/src/effect.ts', `import { Effect } from 'effect';\nexport const run = Effect.runPromise;`);
  assert.equal((await check()).diagnostics.some((entry) => entry.code === 'WS_EFFECT_RUNTIME_ESCAPE'), false);
});

test('Effect runtime aliases are detected without matching unrelated methods', async () => {
  const source = (await ts.createSourceFile('x.ts', `import { Effect as Fx, runSync as execute } from 'effect';
    Fx.runPromise(Fx.succeed(1)); execute(Fx.succeed(1)); Fx.map(Fx.succeed(1), value => value);`, ts.ScriptTarget.Latest, true));
  assert.deepEqual(effectRuntimeExecutionSites(ts, source).map((site) => site.method), ['runPromise', 'runSync']);
});
