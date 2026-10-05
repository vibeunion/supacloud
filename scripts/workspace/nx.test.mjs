import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { nxExecutable } from './nx.mjs';

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'supacloud-nx-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  put('package.json', { private: true });
  return { root, put };
}

test('Nx resolves its public bin metadata across package layouts', (t) => {
  const { root, put } = fixture(t);
  put('node_modules/nx/package.json', { name: 'nx', bin: { nx: './dist/bin/nx.js' } });
  put('node_modules/nx/dist/bin/nx.js', '');
  assert.equal(nxExecutable(root), resolve(root, 'node_modules/nx/dist/bin/nx.js'));
  put('node_modules/nx/package.json', { name: 'nx', bin: './bin/new-entry.mjs' });
  put('node_modules/nx/bin/new-entry.mjs', '');
  assert.equal(nxExecutable(root), resolve(root, 'node_modules/nx/bin/new-entry.mjs'));
});

test('Nx reports missing installation instead of installing an unpinned package', (t) => {
  const { root } = fixture(t);
  assert.throws(() => nxExecutable(root), /not installed/);
});

test('Nx rejects missing or out-of-package executables', (t) => {
  const { root, put } = fixture(t);
  put('node_modules/nx/package.json', { name: 'nx' });
  assert.throws(() => nxExecutable(root), /does not declare/);
  put('node_modules/nx/package.json', { name: 'nx', bin: { nx: './missing.js' } });
  assert.throws(() => nxExecutable(root), /missing or outside/);
  put('node_modules/nx/package.json', { name: 'nx', bin: { nx: '../outside.js' } });
  put('node_modules/outside.js', '');
  assert.throws(() => nxExecutable(root), /missing or outside/);
});
