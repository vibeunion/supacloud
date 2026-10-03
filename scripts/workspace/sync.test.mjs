import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { applySync, derivedFiles, METADATA_PACKAGES, METADATA_PATH, ownedPath, syncPlan, TRUST_ROOT_OUTPUT, TRUST_ROOT_SOURCE } from './sync.mjs';

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'supacloud-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const manifest = (version = '1.2.3') => ({ version, dependencies: { rxjs: '7.8.2' }, peerDependencies: { 'drizzle-orm': '1.0.0-rc.4', '@supabase/supabase-js': '2.115.0' }, devDependencies: { 'drizzle-kit': '1.0.0-rc.4' }, secret: 'do-not-copy' });
  for (const name of Object.values(METADATA_PACKAGES)) put(`packages/${name}/package.json`, manifest());
  put(TRUST_ROOT_SOURCE, '{"mediaType":"fixture"}\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  const commit = () => { git('add', 'packages'); git('commit', '-m', 'Fixture'); };
  return { root, put, manifest, commit };
}

test('preview is read-only, generated content is minimal and apply is idempotent', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(syncPlan(root).map((f) => f.status), ['create', 'create']);
  assert.equal(existsSync(resolve(root, '.nx')), false);
  assert.equal(existsSync(resolve(root, METADATA_PATH)), false);
  applySync(root);
  assert.deepEqual(syncPlan(root).map((f) => f.status), ['current', 'current']);
  const bytes = readFileSync(resolve(root, METADATA_PATH), 'utf8');
  assert.equal(bytes.includes('do-not-copy'), false);
  assert.equal(JSON.parse(bytes).compilerMetadata.version, '1.2.3');
  applySync(root);
  assert.equal(readFileSync(resolve(root, METADATA_PATH), 'utf8'), bytes);
  assert.equal(readFileSync(resolve(root, TRUST_ROOT_OUTPUT), 'utf8'), readFileSync(resolve(root, TRUST_ROOT_SOURCE), 'utf8'));
});

test('changed source creates a reviewable update without modifying version sources', (t) => {
  const { root, put, manifest, commit } = fixture(t);
  applySync(root); commit();
  put('packages/compiler/package.json', manifest('1.3.0'));
  assert.equal(syncPlan(root)[0].status, 'update');
  applySync(root);
  assert.equal(JSON.parse(readFileSync(resolve(root, METADATA_PATH), 'utf8')).compilerMetadata.version, '1.3.0');
  assert.equal(JSON.parse(readFileSync(resolve(root, 'packages/compiler/package.json'), 'utf8')).version, '1.3.0');
});

test('a conflict in either output prevents every managed write', (t) => {
  const { root, put, manifest, commit } = fixture(t);
  applySync(root); commit();
  const before = readFileSync(resolve(root, METADATA_PATH), 'utf8');
  put('packages/compiler/package.json', manifest('2.0.0'));
  put(TRUST_ROOT_OUTPUT, 'user edit\n');
  assert.throws(() => applySync(root), /Uncommitted generated edits/);
  assert.equal(readFileSync(resolve(root, METADATA_PATH), 'utf8'), before);
  assert.equal(readFileSync(resolve(root, TRUST_ROOT_OUTPUT), 'utf8'), 'user edit\n');
  assert.equal(existsSync(resolve(root, '.nx/workspace-sync.lock')), false);
});

test('unknown generated files outside Git history are never overwritten', (t) => {
  const { root, put } = fixture(t);
  put(METADATA_PATH, '{"custom":true}');
  assert.equal(syncPlan(root)[0].status, 'conflict');
  assert.throws(() => applySync(root), /reconciliation/);
  assert.equal(existsSync(resolve(root, TRUST_ROOT_OUTPUT)), false);
});

test('source errors fail before creating output files', (t) => {
  const { root, put, manifest } = fixture(t);
  put('packages/compiler/package.json', manifest('invalid'));
  assert.throws(() => derivedFiles(root), /Invalid starter version/);
  put('packages/compiler/package.json', manifest());
  put(TRUST_ROOT_SOURCE, '{ "mediaType": "fixture" }\n');
  assert.throws(() => applySync(root), /canonical/);
  assert.equal(existsSync(resolve(root, METADATA_PATH)), false);
});

test('sync refuses symlinked output, input and parent directories', (t) => {
  const { root, put } = fixture(t);
  put('outside/data', 'untouched');
  put(METADATA_PATH, ''); rmSync(resolve(root, METADATA_PATH));
  symlinkSync(resolve(root, 'outside/data'), resolve(root, METADATA_PATH));
  assert.throws(() => syncPlan(root), /Symlink/);
  assert.equal(readFileSync(resolve(root, 'outside/data'), 'utf8'), 'untouched');
  rmSync(resolve(root, METADATA_PATH));
  rmSync(resolve(root, TRUST_ROOT_SOURCE));
  symlinkSync(resolve(root, 'outside/data'), resolve(root, TRUST_ROOT_SOURCE));
  assert.throws(() => derivedFiles(root), /Symlink/);
  mkdirSync(resolve(root, 'alias-parent'), { recursive: true });
  symlinkSync(resolve(root, 'alias-parent'), resolve(root, 'alias'));
  assert.throws(() => ownedPath(root, 'alias/new.json'), /Symlink/);
  assert.throws(() => ownedPath(root, '../outside'), /Unsafe/);
});

test('an existing lock blocks writes without deleting another operation lock', (t) => {
  const { root, put } = fixture(t);
  put('.nx/workspace-sync.lock', 'another-operation');
  assert.throws(() => applySync(root), /EEXIST/);
  assert.equal(readFileSync(resolve(root, '.nx/workspace-sync.lock'), 'utf8'), 'another-operation');
  assert.equal(existsSync(resolve(root, METADATA_PATH)), false);
});
