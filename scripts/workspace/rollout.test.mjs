import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { affectedReport, preparationTargets, readWorkspace } from './model.mjs';
import { projectTargets } from './nx-plugin.mjs';
import { buildEnvironment } from './build.mjs';
import { METADATA_PACKAGES, METADATA_PATH, TRUST_ROOT_OUTPUT, TRUST_ROOT_SOURCE } from './sync.mjs';
const repository = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t, policy) {
  const root = mkdtempSync(resolve(tmpdir(), 'supacloud-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), JSON.stringify(value)); };
  for (const name of ['compiler', 'runtime', 'contracts']) {
    put(`packages/${name}/package.json`, { name, scripts: { build: 'node build.mjs', test: 'node test.mjs' } });
    put(`packages/${name}/project.json`, { name, tags: ['type:library'] });
  }
  put('scripts/workspace/policy.json', policy);
  return readWorkspace(root);
}

test('verification dependencies affect preparation, not production/build dependencies', (t) => {
  const workspace = fixture(t, { schemaVersion: 1, verificationPrerequisites: { runtime: ['compiler'] } });
  assert.equal(preparationTargets(workspace, 'runtime').length, 0);
  assert.equal(preparationTargets(workspace, 'runtime', true)[0].projects[0], 'compiler');
  assert.deepEqual(projectTargets(workspace, workspace.projects.runtime)['repo-install'].dependsOn, []);
  assert.ok(affectedReport(workspace, ['packages/compiler/src/index.ts']).projects.some((p) => p.name === 'runtime'));
});

test('file-level generation inputs invalidate consumers without creating false project cycles', (t) => {
  const workspace = fixture(t, { schemaVersion: 1, fileInputs: { compiler: ['packages/runtime/package.json'] } });
  assert.equal(workspace.edges.length, 0);
  const report = affectedReport(workspace, ['packages/runtime/package.json']);
  assert.ok(report.projects.find((p) => p.name === 'compiler').reasons[0].includes('Generated input'));
  assert.equal(report.safeToSkip, false);
  assert.ok(projectTargets(workspace, workspace.projects.compiler)['repo-build'].inputs.includes('{workspaceRoot}/packages/runtime/package.json'));
});

test('cache is opt-in for one build; installs, tests and verification never cache', (t) => {
  const workspace = fixture(t, { schemaVersion: 1, cacheBuilds: ['contracts'] });
  const targets = projectTargets(workspace, workspace.projects.contracts);
  assert.equal(targets['repo-build'].cache, true);
  assert.equal(targets['repo-install'].cache, false);
  assert.equal(targets['repo-test'].cache, false);
  assert.equal(targets['repo-prepare'].cache, false);
  assert.equal(projectTargets(workspace, workspace.projects.runtime)['repo-build'].cache, false);
  assert.ok(targets['repo-build'].inputs.some((input) => input.runtime?.includes('--hash packages/contracts')));
});

for (const policy of [null, [], { schemaVersion: 2 }, { schemaVersion: 1, fileInputs: [] }, { schemaVersion: 1, verificationPrerequisites: { runtime: ['absent'] } }, { schemaVersion: 1, fileInputs: { runtime: ['packages/../secret'] } }, { schemaVersion: 1, cacheBuilds: null }, { schemaVersion: 1, cacheBuilds: ['contracts', 'contracts'] }]) {
  test(`invalid policies fail closed: ${JSON.stringify(policy)}`, (t) => assert.throws(() => fixture(t, policy), /Invalid/));
}

test('cached build environment does not forward caller credentials or runtime hooks', () => {
  const environment = buildEnvironment({ PATH: '/bin', HOME: '/tmp', SECRET_TOKEN: 'secret', NODE_OPTIONS: '--require injected', NODE_ENV: 'test', NX_TASK_HASH: 'volatile' });
  assert.equal(environment.SECRET_TOKEN, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.NX_TASK_HASH, undefined);
  assert.equal(environment.NODE_ENV, 'production');
  assert.equal(environment.TZ, 'UTC');
});

test('release version updates maintain every explicit starter version snapshot', () => {
  const config = JSON.parse(readFileSync(resolve(repository, 'release-please-config.json'), 'utf8'));
  for (const [key, name] of Object.entries(METADATA_PACKAGES)) {
    assert.ok(config.packages[`packages/${name}`]['extra-files'].some((entry) => entry.type === 'json' && entry.path === `/${METADATA_PATH}` && entry.jsonpath === `$.${key}.version`));
  }
});

test('trusted root extraction preserves exact canonical security input', () => {
  assert.deepEqual(readFileSync(resolve(repository, TRUST_ROOT_OUTPUT)), readFileSync(resolve(repository, TRUST_ROOT_SOURCE)));
});

test('no publishable package depends on Nx and no unresolved static debt is budgeted', () => {
  const workspace = readWorkspace(repository);
  for (const project of Object.values(workspace.projects)) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(project.manifest[field]?.nx, undefined);
  }
  const baseline = JSON.parse(readFileSync(resolve(repository, 'scripts/workspace/source-baseline.json'), 'utf8'));
  assert.ok(baseline.entries.every((entry) => entry.code === 'WS_DYNAMIC_IMPORT'));
});
