import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { readWorkspace } from './model.mjs';
import { checkSourceBoundaries, importSites } from './source.mjs';

const ts = createRequire(new URL('../../packages/compiler/package.json', import.meta.url))('@typescript/typescript6');
function fixture(t, source) {
  const root = mkdtempSync(resolve(tmpdir(), 'supacloud-source-hardening-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  for (const name of ['client', 'public', 'secret']) {
    put(`packages/${name}/package.json`, { name: `@test/${name}`, exports: { '.': './src/index.ts' }, dependencies: name === 'client' ? { '@test/public': 'file:../public' } : {} });
    put(`packages/${name}/project.json`, { name: `@test/${name}`, tags: ['scope:test', `type:${name}`] });
    put(`packages/${name}/src/index.ts`, name === 'client' ? source : 'export const value = 1;');
  }
  return { root, put, check: () => checkSourceBoundaries(readWorkspace(root), ts, [{ sourceTag: 'type:client', bannedDependenciesWithTags: ['type:secret'] }]) };
}

for (const specifier of ['@test/public', '@test/client']) {
  test(`named or self package aliases cannot hide a forbidden actual owner: ${specifier}`, (t) => {
    const { put, check } = fixture(t, `import {value} from '${specifier}';`);
    put('packages/client/tsconfig.json', { compilerOptions: { baseUrl: '.', paths: { [specifier]: ['../secret/src/index.ts'] } } });
    const report = check();
    assert.ok(report.edges.some((edge) => edge.target === '@test/secret'));
    assert.ok(report.diagnostics.some((entry) => entry.code === 'WS_BOUNDARY_VIOLATION'));
    assert.ok(report.diagnostics.some((entry) => entry.code === 'WS_PRIVATE_IMPORT'));
    assert.ok(report.diagnostics.some((entry) => entry.code === 'WS_UNDECLARED_IMPORT'));
  });
}

test('missing alias outputs are unverified, not silently clean', (t) => {
  const { put, check } = fixture(t, "import {value} from '@hidden/missing';");
  put('packages/client/tsconfig.json', { compilerOptions: { paths: { '@hidden/*': ['../secret/dist/*.js'] } } });
  assert.ok(check().notes.some((entry) => entry.code === 'WS_UNRESOLVED_ALIAS'));
});

test('self package imports must still use public subpaths', (t) => {
  const { check } = fixture(t, "import '@test/client/private';");
  assert.ok(check().diagnostics.some((entry) => entry.code === 'WS_PRIVATE_IMPORT'));
});

test('require aliases and import.meta.resolve contribute module references', () => {
  const source = ts.createSourceFile('x.mts', `import {createRequire as makeRequire} from 'node:module';
    const fromHere = makeRequire(import.meta.url);
    fromHere('@test/secret'); fromHere.resolve('@test/secret/private');
    import.meta.resolve('@test/public'); fromHere(variable);`, ts.ScriptTarget.Latest, true);
  assert.deepEqual(importSites(ts, source).map((site) => site.specifier), ['node:module', '@test/secret', '@test/secret/private', '@test/public', null]);
});

test('handwritten declaration imports are checked', (t) => {
  const { put, check } = fixture(t, 'export {};');
  put('packages/client/src/types.d.ts', "export type T = import('@test/secret').T;");
  assert.ok(check().diagnostics.some((entry) => entry.file.endsWith('types.d.ts') && entry.code === 'WS_BOUNDARY_VIOLATION'));
});

test('skipped source symlinks are explicit coverage findings', (t) => {
  const { root, check } = fixture(t, 'export {};');
  symlinkSync(resolve(root, 'packages/secret/src/index.ts'), resolve(root, 'packages/client/src/linked.ts'));
  assert.ok(check().notes.some((entry) => entry.code === 'WS_SOURCE_SYMLINK'));
});

test('fingerprints survive line changes, but not changed import symbols or destinations', () => {
  const sites = (text) => importSites(ts, ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true));
  const hash = sites("import {value} from '@test/secret';")[0].fingerprint;
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(sites("// new comment\n\nimport { value } from '@test/secret';")[0].fingerprint, hash);
  assert.notEqual(sites("import {other} from '@test/secret';")[0].fingerprint, hash);
});

test('installed dependency copies are not mistaken for the importing project', (t) => {
  const { put, check } = fixture(t, "import {value} from '@test/secret';");
  put('packages/client/node_modules/@test/secret/package.json', { name: '@test/secret', exports: { '.': './index.js' } });
  put('packages/client/node_modules/@test/secret/index.js', 'export const value = 1;');
  assert.ok(check().diagnostics.some((entry) => entry.code === 'WS_BOUNDARY_VIOLATION'));
});
