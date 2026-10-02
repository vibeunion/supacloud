import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkEsmManifest, checkEsmPack, checkRepository, checkPackedDirectory } from './esm-package-policy.mjs';

const manifest = () => ({
  name: '@supacloud/example', version: '1.0.0', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' } },
  scripts: { build: 'bun build src/index.ts --outdir dist --format esm' },
});
const files = ['package.json', 'dist/index.js', 'dist/index.d.ts'];

test('ESM .js and explicit .mjs exports both pass', () => {
  assert.deepEqual(checkEsmPack(manifest(), files), []);
  const candidate = manifest();
  candidate.exports['.'].import = './dist/index.mjs';
  assert.deepEqual(checkEsmPack(candidate, [...files, 'dist/index.mjs']), []);
});

test('a require condition is rejected even when nested or pointing at ESM', () => {
  const candidate = { ...manifest(), exports: { '.': { node: [{ require: './dist/index.js' }] } } };
  assert.match(checkEsmManifest(candidate).join('\n'), /exports\.\.\.node\[0\]\.require/);
});

test('CJS runtime and declaration targets are rejected in every public metadata field', () => {
  for (const field of ['main', 'module', 'types', 'typings', 'browser']) {
    for (const path of ['./dist/index.cjs', './dist/index.d.cts']) {
      assert.match(checkEsmManifest({ ...manifest(), [field]: path }).join('\n'), /CommonJS target/);
    }
  }
  assert.match(checkEsmManifest({ ...manifest(), exports: { '.': ['./dist/index.cjs'] } }).join('\n'), /CommonJS target/);
});

test('library .js exports require an explicit module package scope', () => {
  assert.match(checkEsmManifest({ ...manifest(), type: 'commonjs' }).join('\n'), /type: module/);
});

test('CommonJS build flags are rejected for space, equals and quoted spellings', () => {
  for (const format of ['--format cjs', '--format=cjs', '--format "cjs"', "--format='cjs'"]) {
    assert.match(checkEsmManifest({ ...manifest(), scripts: { build: `bun build index.ts ${format}` } }).join('\n'), /CommonJS builds/);
  }
});

test('stale artifacts, declarations and source maps cannot leak into a package', () => {
  for (const path of ['dist/old.cjs', 'dist/old.cjs.map', 'dist/old.d.cts', 'dist/old.d.cts.map']) {
    assert.match(checkEsmPack(manifest(), [...files, path]).join('\n'), /unexpected CommonJS artifact/);
  }
});

test('missing public JS, types and bin targets fail the pack check', () => {
  for (const path of ['dist/index.js', 'dist/index.d.ts']) {
    assert.match(checkEsmPack(manifest(), files.filter(file => file !== path)).join('\n'), /published target is missing/);
  }
  assert.match(checkEsmPack({ ...manifest(), bin: { example: './dist/cli.js' } }, files).join('\n'), /published target is missing/);
});

test('Lite launcher is an exact bin-only exception, not permission for dual libraries', () => {
  const lite = { ...manifest(), name: '@supacloud/lite', bin: { 'supacloud-lite': 'dist/launcher.cjs' } };
  assert.deepEqual(checkEsmPack(lite, [...files, 'dist/launcher.cjs']), []);
  assert.match(checkEsmPack({ ...lite, bin: undefined }, [...files, 'dist/launcher.cjs']).join('\n'), /unexpected CommonJS artifact/);
  assert.match(checkEsmPack(lite, [...files, 'dist/other.cjs']).join('\n'), /unexpected CommonJS artifact/);
  assert.match(checkEsmManifest({ ...manifest(), bin: { other: 'dist/launcher.cjs' } }).join('\n'), /unapproved CommonJS launcher/);
  assert.match(checkEsmManifest({ ...lite, exports: { '.': './dist/launcher.cjs' } }).join('\n'), /CommonJS target/);
});

test('private packages, dependency manifests and fixture filenames are not an ESM policy sweep', () => {
  assert.deepEqual(checkEsmManifest({ ...manifest(), private: true, type: 'commonjs' }), []);
  assert.deepEqual(checkEsmManifest({ name: 'third-party', main: 'index.cjs' }), []);
  assert.deepEqual(checkEsmManifest({ ...manifest(), scripts: { test: 'bun test compatibility.cjs.test.ts' } }), []);
});

test('wildcard exports fail explicitly instead of silently skipping artifact validation', () => {
  assert.match(checkEsmPack({ ...manifest(), exports: { './*': './dist/*.js' } }, files).join('\n'), /wildcard target/);
});

test('repository scan validates real top-level packages but not node_modules or CJS fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supacloud-esm-policy-'));
  try {
    await mkdir(join(root, 'packages', 'example', 'node_modules', 'legacy'), { recursive: true });
    await mkdir(join(root, 'packages', 'no-manifest'));
    const path = join(root, 'packages', 'example', 'package.json');
    await writeFile(path, JSON.stringify(manifest()));
    await writeFile(join(root, 'packages', 'example', 'node_modules', 'legacy', 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(root, 'packages', 'example', 'fixture.cjs'), 'module.exports = 1;');
    await checkRepository(root);
    await writeFile(path, JSON.stringify({ ...manifest(), type: 'commonjs' }));
    await assert.rejects(checkRepository(root), /example\/package.json/);
    await writeFile(path, '{');
    await assert.rejects(checkRepository(root), SyntaxError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('real npm pack inventory rejects stale CJS files and skips prepack/postpack hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supacloud-esm-pack-'));
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'package.json'), JSON.stringify({
      ...manifest(), files: ['dist'], scripts: { prepack: 'exit 91', postpack: 'exit 92' },
    }));
    await writeFile(join(root, 'dist', 'index.js'), 'export const ready = true;');
    await writeFile(join(root, 'dist', 'index.d.ts'), 'export declare const ready: boolean;');
    await checkPackedDirectory(root);
    await writeFile(join(root, 'dist', 'index.cjs'), 'module.exports = {};');
    await assert.rejects(checkPackedDirectory(root), /unexpected CommonJS artifact/);
    await rm(join(root, 'dist', 'index.cjs'));
    await rm(join(root, 'dist', 'index.d.ts'));
    await assert.rejects(checkPackedDirectory(root), /published target is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main-only libraries cannot bypass the policy by omitting exports', () => {
  assert.match(checkEsmManifest({ name: '@supacloud/example', main: 'dist/index.cjs' }).join('\n'), /CommonJS target/);
});
