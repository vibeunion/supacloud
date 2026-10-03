import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { ACCEPTANCE_PROJECT, affectedReport, buildPrerequisites, graphReport, readWorkspace, resolveProject } from './model.mjs';
import { changedInputs, parseArgs } from './cli.mjs';
import { createDependencies, createNodesV2, projectTargets } from './nx-plugin.mjs';

function fixture(t, manifests = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'supacloud-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), typeof data === 'string' ? data : JSON.stringify(data)); };
  for (const name of ['contracts', 'app', 'compiler', 'web']) {
    put(`packages/${name}/package.json`, { name: `@test/${name}`, scripts: { build: 'echo build', test: 'echo test' }, ...manifests[name] });
    put(`packages/${name}/project.json`, { name: `@test/${name}`, tags: ['scope:test', 'type:library'] });
  }
  return { root, put };
}

const deps = {
  app: { dependencies: { '@test/contracts': 'file:../contracts' } },
  compiler: { dependencies: { '@test/contracts': '^1.0.0' } },
  web: { dependencies: { '@test/app': 'file:../app' } },
};

test('project graph preserves declaration kinds and local build prerequisites', (t) => {
  const { root } = fixture(t, deps);
  const workspace = readWorkspace(root);
  assert.deepEqual(buildPrerequisites(workspace, '@test/app'), ['@test/contracts']);
  assert.deepEqual(buildPrerequisites(workspace, '@test/compiler'), []);
  assert.equal(workspace.edges.find((edge) => edge.source === '@test/compiler').local, false);
  assert.equal(resolveProject(workspace, 'web').name, '@test/web');
  assert.equal(resolveProject(workspace, 'packages/app').packageName, '@test/app');
  assert.throws(() => resolveProject(workspace, 'unknown'), /unambiguous/);
  assert.equal(graphReport(workspace).acceptance.cache, false);
});

test('affected computes reverse closure, never runtime dependencies as acceptance edges', (t) => {
  const { root } = fixture(t, deps);
  const workspace = readWorkspace(root);
  const report = affectedReport(workspace, ['packages/contracts/src/index.ts']);
  assert.deepEqual(report.projects.map((project) => project.name), ['@test/app', '@test/compiler', '@test/contracts', '@test/web', ACCEPTANCE_PROJECT]);
  assert.equal(report.mode, 'shadow');
  assert.equal(report.safeToSkip, false);
  assert.equal(report.full, false);
  assert.equal(workspace.edges.some((edge) => edge.target === ACCEPTANCE_PROJECT), false);
  assert.match(report.projects.find((project) => project.name === '@test/web').reasons[0], /Depends on/);
});

test('empty input remains explicitly unsafe to skip', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(affectedReport(readWorkspace(root), []).projects, []);
  assert.equal(affectedReport(readWorkspace(root), []).safeToSkip, false);
});

for (const file of ['nx.json', 'scripts/template.ts', 'packages/removed/file.ts', '../outside', 'packages/app/../web/file.ts']) {
  test(`shared/unowned/deleted/path escape input falls back to all: ${file}`, (t) => {
    const { root } = fixture(t);
    const report = affectedReport(readWorkspace(root), [file]);
    assert.equal(report.full, true);
    assert.equal(report.projects.length, 5);
  });
}

test('missing metadata, invalid names and duplicate identities fail closed', (t) => {
  const { root, put } = fixture(t);
  put('packages/web/project.json', { name: '@test/app', tags: [] });
  assert.throws(() => readWorkspace(root), /Duplicate/);
  put('packages/web/project.json', { name: 'bad;echo injected', tags: [] });
  assert.throws(() => readWorkspace(root), /Invalid/);
  rmSync(resolve(root, 'packages/web/project.json'));
  assert.throws(() => readWorkspace(root), /ENOENT/);
});

test('local links must resolve to the declared workspace package', (t) => {
  const { root, put } = fixture(t, { app: { dependencies: { '@test/contracts': 'file:../compiler' } } });
  assert.throws(() => readWorkspace(root), /Unresolved\/mismatched/);
  put('packages/app/package.json', { name: '@test/app', dependencies: { '@test/contracts': 'file:../../../outside' } });
  assert.throws(() => readWorkspace(root), /Unresolved\/mismatched/);
});

test('dev and override edges are typed, deduplicated only at the Nx adapter', async (t) => {
  const { root } = fixture(t, { app: { devDependencies: { '@test/contracts': 'file:../contracts' }, overrides: { '@test/contracts': 'file:../contracts' } } });
  const workspace = readWorkspace(root);
  assert.equal(workspace.edges.length, 2);
  assert.deepEqual(buildPrerequisites(workspace, '@test/app'), ['@test/contracts']);
  const result = await createDependencies({}, { workspaceRoot: root });
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceFile, 'packages/app/package.json');
});

test('cycles and unmodeled nested overrides fail instead of incomplete graphs', (t) => {
  const { root, put } = fixture(t, { ...deps, contracts: { devDependencies: { '@test/web': 'file:../web' } } });
  assert.throws(() => readWorkspace(root), /cycle/);
  put('packages/contracts/package.json', { name: '@test/contracts', overrides: { external: { nested: '1' } } });
  assert.throws(() => readWorkspace(root), /Nested overrides/);
});

test('Nx targets delegate to Bun with uncached installs ordered after local builds', (t) => {
  const { root } = fixture(t, deps);
  const workspace = readWorkspace(root);
  const targets = projectTargets(workspace, workspace.projects['@test/app']);
  assert.equal(targets['repo-build'].executor, 'nx:run-commands');
  assert.equal(targets['repo-build'].options.command, 'bun run build');
  assert.deepEqual(targets['repo-install'].dependsOn, [{ projects: ['@test/contracts'], target: 'repo-build', params: 'ignore' }]);
  assert.deepEqual(targets['repo-build'].dependsOn, [{ target: 'repo-install', params: 'ignore' }]);
  assert.equal(Object.values(targets).every((target) => target.cache === false), true);
  assert.equal('repo-clean' in targets, false);
});

test('plugin defines all projects plus an uncached packed-consumer target', async (t) => {
  const { root } = fixture(t, deps);
  const files = ['app', 'compiler', 'contracts', 'web'].map((name) => `packages/${name}/project.json`);
  const result = await createNodesV2[1](files, {}, { workspaceRoot: root });
  const acceptance = result[0][1].projects['scripts/workspace'];
  assert.equal(result.length, 4);
  assert.equal(acceptance.name, ACCEPTANCE_PROJECT);
  assert.equal(acceptance.implicitDependencies.length, 4);
  assert.equal(acceptance.targets['app-generation'].cache, false);
});

test('CLI rejects typos, duplicate flags, missing values and cross-command flags', () => {
  for (const args of [[], ['unknown'], ['graph', '--base', 'main'], ['affected', '--base'], ['affected', '--base', 'a', '--base', 'b']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(parseArgs(['build', '--project', 'app']).options, { '--project': 'app' });
});

test('Git baseline errors and mismatched head return full-validation reasons', (t) => {
  const { root } = fixture(t);
  assert.match(changedInputs(root).fallbackReason, /baseline/);
  assert.match(changedInputs(root, 'missing').fallbackReason, /could not/);
});

test('Git inputs include rename source/destination, dirty deletions, spaces and new files', (t) => {
  const { root, put } = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  put('packages/app/old name.ts', 'export const x = 1;');
  git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  renameSync(resolve(root, 'packages/app/old name.ts'), resolve(root, 'packages/web/new name.ts'));
  git('add', '.'); git('commit', '-m', 'rename');
  rmSync(resolve(root, 'packages/compiler/project.json'));
  put('packages/contracts/untracked.ts', '');
  const report = changedInputs(root, base);
  for (const file of ['packages/app/old name.ts', 'packages/web/new name.ts', 'packages/compiler/project.json', 'packages/contracts/untracked.ts']) assert.ok(report.files.includes(file));
  assert.match(changedInputs(root, base, base).fallbackReason, /checked-out/);
});

test('prepare delegates to Nx without installing or rebuilding the consumer', (t) => {
  const { root } = fixture(t, deps);
  const workspace = readWorkspace(root);
  const target = projectTargets(workspace, workspace.projects['@test/web'])['repo-prepare'];
  assert.equal(target.executor, 'nx:noop'); assert.equal(target.cache, false);
  assert.deepEqual(target.dependsOn, [{ projects: ['@test/app'], target: 'repo-build', params: 'ignore' }]);
  assert.deepEqual(parseArgs(['prepare', '--project', 'web']).options, { '--project': 'web' });
});

test('source-only local packages retain installation and transitive build prerequisites', (t) => {
  const { root } = fixture(t, { ...deps, app: { ...deps.app, scripts: {} } });
  const workspace = readWorkspace(root);
  assert.deepEqual(projectTargets(workspace, workspace.projects['@test/web'])['repo-install'].dependsOn,
    [{ projects: ['@test/app'], target: 'repo-install', params: 'ignore' }]);
  assert.deepEqual(projectTargets(workspace, workspace.projects['@test/app'])['repo-install'].dependsOn,
    [{ projects: ['@test/contracts'], target: 'repo-build', params: 'ignore' }]);
});


test('symlinked package directories cannot disappear from workspace discovery', (t) => {
  const { root } = fixture(t);
  symlinkSync(resolve(root, 'packages/app'), resolve(root, 'packages/linked'), 'junction');
  assert.throws(() => readWorkspace(root), /Symlinked workspace package/);
});
