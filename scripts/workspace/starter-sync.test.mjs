import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { affectedReport, preparationTargets, readWorkspace } from './model.mjs';
import { applyStarterSync, checkStarterReleaseConfig, planStarterSync, STARTER_FILE, STARTER_PACKAGES, starterMetadata } from './starter-sync.mjs';
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'starter-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
  for (const [, [directory, name]] of Object.entries(STARTER_PACKAGES)) put(`packages/${directory}/package.json`, { name, version: '1.0.0', dependencies: { rxjs: '7.8.2' }, peerDependencies: { 'drizzle-orm': '1.0.0-rc.5-169397b', '@supabase/supabase-js': '^2.0.0' }, devDependencies: { 'drizzle-kit': '1.0.0-rc.5-ab785fc' } });
  mkdirSync(dirname(resolve(root, STARTER_FILE)), { recursive: true });
  const config = { packages: Object.fromEntries(Object.entries(STARTER_PACKAGES).map(([alias, [directory]]) => [`packages/${directory}`, { 'extra-files': [{ type: 'json', path: `/${STARTER_FILE}`, jsonpath: `$.packages.${alias}.version` }] }])) };
  put('release-please-config.json', config);
  return { root, put, config };
}
test('preview is read-only and apply is idempotent without rewriting unchanged files', (t) => {
  const { root } = fixture(t);
  const plan = planStarterSync(root);
  assert.equal(plan.changed, true); assert.equal(existsSync(resolve(root, STARTER_FILE)), false);
  applyStarterSync(plan.planHash, root);
  const mtime = statSync(resolve(root, STARTER_FILE)).mtimeMs;
  const second = planStarterSync(root); assert.equal(second.changed, false);
  applyStarterSync(second.planHash, root);
  assert.equal(statSync(resolve(root, STARTER_FILE)).mtimeMs, mtime);
  assert.deepEqual(JSON.parse(readFileSync(resolve(root, STARTER_FILE))), starterMetadata(root));
});
test('changed input or destination invalidates a previously reviewed plan', (t) => {
  const { root, put } = fixture(t);
  const plan = planStarterSync(root);
  put('packages/compiler/package.json', { name: '@supacloud/compiler', version: '1.1.0' });
  assert.throws(() => applyStarterSync(plan.planHash, root), /conflict/);
  const next = planStarterSync(root); applyStarterSync(next.planHash, root);
  const stale = planStarterSync(root);
  put(STARTER_FILE, readFileSync(resolve(root, STARTER_FILE), 'utf8') + '\n');
  assert.throws(() => applyStarterSync(stale.planHash, root), /conflict/);
  assert.equal(existsSync(resolve(root, STARTER_FILE) + '.sync-lock'), false);
});
test('unowned files, invalid manifests and missing fields fail without overwriting', (t) => {
  const { root, put } = fixture(t);
  put(STARTER_FILE, '{"user":"keep"}');
  assert.throws(() => planStarterSync(root), /not owned/);
  assert.equal(readFileSync(resolve(root, STARTER_FILE), 'utf8'), '{"user":"keep"}');
  rmSync(resolve(root, STARTER_FILE));
  put('packages/app/package.json', { name: '@supacloud/app', version: '1.0.0' });
  assert.throws(() => starterMetadata(root), /Missing publishable/);
  put('packages/app/package.json', { name: 'wrong', version: '1.0.0' });
  assert.throws(() => starterMetadata(root), /identity/);
});
test('destination and parent symlinks are rejected', (t) => {
  const { root, put } = fixture(t);
  put('keep.json', '{}'); symlinkSync(resolve(root, 'keep.json'), resolve(root, STARTER_FILE));
  assert.throws(() => planStarterSync(root), /non-regular/);
  rmSync(dirname(resolve(root, STARTER_FILE)), { recursive: true });
  mkdirSync(resolve(root, 'outside')); symlinkSync(resolve(root, 'outside'), dirname(resolve(root, STARTER_FILE)), 'dir');
  assert.throws(() => planStarterSync(root), /unsafe parent/);
});
test('release updates are per-package and cover every embedded version', (t) => {
  const { root, put, config } = fixture(t);
  checkStarterReleaseConfig(root);
  delete config.packages['packages/contracts']['extra-files']; put('release-please-config.json', config);
  assert.throws(() => checkStarterReleaseConfig(root), /contracts/);
});
test('apply needs a preview token and never takes over an existing lock', (t) => {
  const { root, put } = fixture(t);
  assert.throws(() => applyStarterSync(undefined, root), /requires/);
  const plan = planStarterSync(root); put(STARTER_FILE + '.sync-lock', 'another writer');
  assert.throws(() => applyStarterSync(plan.planHash, root), /EEXIST/);
  assert.equal(readFileSync(resolve(root, STARTER_FILE) + '.sync-lock', 'utf8'), 'another writer');
});

test('nested custom fields are preserved by refusing synchronization', (t) => {
  const { root, put } = fixture(t);
  const data = starterMetadata(root); data.packages.app.custom = 'keep'; put(STARTER_FILE, data);
  assert.throws(() => planStarterSync(root), /unowned/);
  assert.equal(JSON.parse(readFileSync(resolve(root, STARTER_FILE))).packages.app.custom, 'keep');
});
test('generation relationships affect the CLI but never install producers as runtime dependencies', (t) => {
  const { root, put } = fixture(t);
  for (const [directory, name] of [...Object.values(STARTER_PACKAGES), ['cli', '@supacloud/cli']]) {
    put(`packages/${directory}/project.json`, { name, tags: ['scope:tooling', 'type:library'] });
  }
  put('packages/cli/package.json', { name: '@supacloud/cli', version: '1.0.0' });
  applyStarterSync(planStarterSync(root).planHash, root);
  const workspace = readWorkspace(root);
  assert.equal(workspace.edges.filter((edge) => edge.kind === 'generation').length, 7);
  assert.deepEqual(preparationTargets(workspace, '@supacloud/cli'), []);
  const affected = affectedReport(workspace, ['packages/app/package.json']);
  assert.ok(affected.projects.some((project) => project.name === '@supacloud/cli'));
  assert.equal(affected.safeToSkip, false);
  rmSync(resolve(root, 'packages/app'), { recursive: true });
  assert.throws(() => readWorkspace(root), /Missing starter metadata producer/);
});

test('metadata rejects credential-bearing sources and invalid prerelease identifiers', (t) => {
  const { root, put } = fixture(t);
  put('packages/app/package.json', { name: '@supacloud/app', version: '1.0.0', dependencies: { rxjs: 'https://example.invalid/private.tgz' } });
  assert.throws(() => starterMetadata(root), /Missing publishable/);
  put('packages/app/package.json', { name: '@supacloud/app', version: '1.0.0-01', dependencies: { rxjs: '7.8.2' } });
  assert.throws(() => starterMetadata(root), /identity\/version/);
  assert.equal(existsSync(resolve(root, STARTER_FILE)), false);
});
