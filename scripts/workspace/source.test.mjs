import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { readWorkspace } from './model.mjs';
import { checkSourceBoundaries, importSites, productionSources, publicSubpath } from './source.mjs';

const require = createRequire(new URL('../../packages/compiler/package.json', import.meta.url));
const ts = require('@typescript/typescript6');
function fixture(t, source, extra = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'supacloud-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, data) => { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), typeof data === 'string' ? data : JSON.stringify(data)); };
  for (const name of ['client', 'server']) {
    put(`packages/${name}/package.json`, { name: `@test/${name}`, exports: { '.': './src/index.ts', './public': './src/public.ts' }, ...(name === 'client' ? extra : {}) });
    put(`packages/${name}/project.json`, { name: `@test/${name}`, tags: [`type:${name}`] });
    put(`packages/${name}/src/index.ts`, name === 'client' ? source : 'export const value = 1;');
    put(`packages/${name}/src/public.ts`, 'export const value = 1;');
  }
  return { root, put, check: (rules = []) => checkSourceBoundaries(readWorkspace(root), ts, rules) };
}

test('AST sites include re-exports, type imports, require and literal dynamic imports, not comments or strings', () => {
  const source = ts.createSourceFile('test.ts', `
    // import 'comment';
    const text = "import 'string'";
    import type { A } from 'type';
    export { A } from 'export';
    import C = require('equals');
    type D = import('type-query').D;
    require('require'); require.resolve('resolve');
    import('dynamic'); import(variable);
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(importSites(ts, source).map((site) => site.specifier), ['type', 'export', 'equals', 'type-query', 'require', 'resolve', 'dynamic', null]);
  assert.equal(importSites(ts, source).every((site) => site.line > 0 && site.column > 0), true);
});

test('public exports honor conditions, wildcard specificity, null blocks and traversal rejection', () => {
  const exports = { '.': { import: './index.js' }, './*': './dist/*.js', './internal/*': null, './private': null };
  assert.equal(publicSubpath(exports, '.'), true);
  assert.equal(publicSubpath(exports, './public'), true);
  assert.equal(publicSubpath(exports, './private'), false);
  assert.equal(publicSubpath(exports, './internal/foo'), false);
  assert.equal(publicSubpath(exports, './foo/../private'), false);
  assert.equal(publicSubpath(undefined, './private'), false);
  assert.equal(publicSubpath({ import: './index.js', types: './index.d.ts' }, '.'), true);
  assert.equal(publicSubpath(null, '.'), false);
});

test('declared public package entrypoint passes without inventing an architecture rule', (t) => {
  const { check } = fixture(t, "import {value} from '@test/server/public';", { dependencies: { '@test/server': 'file:../server' } });
  const report = check();
  assert.equal(report.diagnostics.length, 0);
  assert.equal(report.edges.length, 1);
});

test('deep imports and undeclared internal packages produce positioned diagnostics', (t) => {
  const { check } = fixture(t, "import {value} from '@test/server/src/index';");
  const report = check();
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.code), ['WS_PRIVATE_IMPORT', 'WS_UNDECLARED_IMPORT']);
  assert.equal(report.diagnostics[0].file, 'packages/client/src/index.ts');
  assert.equal(report.diagnostics[0].line, 1);
});

test('relative cross-package paths cannot bypass export checks', (t) => {
  const { check } = fixture(t, "export {value} from '../../server/src/index';");
  assert.equal(check().diagnostics[0].code, 'WS_PRIVATE_IMPORT');
});

test('TypeScript path aliases resolve to the owned source package', (t) => {
  const { put, check } = fixture(t, "import {value} from '@hidden/server';");
  put('packages/client/tsconfig.json', { compilerOptions: { baseUrl: '.', paths: { '@hidden/*': ['../*/src/index.ts'] } } });
  assert.equal(check().diagnostics[0].code, 'WS_PRIVATE_IMPORT');
});

test('the caller supplies existing tag rules; imports cannot evade banned target tags', (t) => {
  const { check } = fixture(t, "import type {value} from '@test/server';", { dependencies: { '@test/server': '^1' } });
  const report = check([{ sourceTag: 'type:client', bannedDependenciesWithTags: ['type:server'], description: 'Client may not import server.' }]);
  assert.equal(report.diagnostics[0].code, 'WS_BOUNDARY_VIOLATION');
  assert.equal(report.diagnostics[0].message, 'Client may not import server.');
});

test('computed imports are explicitly reported as unverified, not silently proven safe', (t) => {
  const { check } = fixture(t, 'const target = process.argv[2]; import(target);');
  const report = check();
  assert.equal(report.notes[0].code, 'WS_DYNAMIC_IMPORT');
  assert.equal(report.diagnostics.length, 0);
});

test('production scan excludes tests, generated sources and fixtures', (t) => {
  const { root, put, check } = fixture(t, 'export const x = 1;');
  for (const file of ['src/private.test.ts', 'src/types.d.ts', 'src/fixtures/private.ts', 'src/generated/private.ts']) put(`packages/client/${file}`, "import '@test/server/private';");
  assert.equal(productionSources(resolve(root, 'packages/client/src')).length, 2);
  assert.equal(check().diagnostics.length, 0);
});

test('invalid source and invalid configs fail instead of declaring a clean scan', (t) => {
  const { put, check } = fixture(t, 'import {');
  assert.equal(check().diagnostics[0].code, 'WS_SOURCE_PARSE');
  put('packages/client/tsconfig.json', '{');
  assert.throws(() => check());
});
