import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nxExecutable } from './nx.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const nx = nxExecutable(repository);
const root = mkdtempSync(resolve(tmpdir(), 'supacloud-cache-'));
const env = { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true', NX_TUI: 'false', NX_INTERACTIVE: 'false' };
const put = (file, data) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), typeof data === 'string' ? data : JSON.stringify(data)); };
const run = (command, args, cwd = root, expected = true, overrides = {}) => {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if ((result.status === 0) !== expected) throw new Error(`Unexpected cache acceptance exit ${result.status}: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
};
try {
  cpSync(resolve(repository, 'scripts/workspace'), resolve(root, 'scripts/workspace'), { recursive: true });
  symlinkSync(resolve(repository, 'node_modules'), resolve(root, 'node_modules'), 'junction');
  put('scripts/workspace/policy.json', { schemaVersion: 1, cacheBuilds: ['@fixture/pure'] });
  put('package.json', { name: 'cache-fixture', private: true, type: 'module' });
  put('tsconfig.base.json', { compilerOptions: { paths: {} }, files: [] });
  put('nx.json', { plugins: ['./scripts/workspace/nx-plugin.mjs'], namedInputs: {
    default: ['{projectRoot}/**/*', '!{projectRoot}/dist/**/*', '!{projectRoot}/node_modules/**/*', '{workspaceRoot}/build-settings.json', '{workspaceRoot}/scripts/workspace/**/*'],
  } });
  put('.gitignore', 'node_modules/\n.nx/\n**/dist/\ntrace.jsonl\n.env*\n');
  put('build-settings.json', { value: 1 });
  put('packages/source/package.json', { name: '@fixture/source', version: '1.0.0', type: 'module' });
  put('packages/source/project.json', { name: '@fixture/source', tags: ['type:fixture'] });
  put('packages/pure/package.json', { dependencies: { '@fixture/source': 'file:../source' }, name: '@fixture/pure', version: '1.0.0', type: 'module', scripts: { build: 'node build.mjs' } });
  put('packages/pure/project.json', { name: '@fixture/pure', tags: ['type:fixture'] });
  put('packages/pure/input.txt', 'first');
  // The ignored trace is outside the output folder: replaying logs cannot fake a cache hit.
  put('packages/pure/build.mjs', `import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
mkdirSync('dist',{recursive:true}); writeFileSync('dist/result',readFileSync('input.txt','utf8')+readFileSync('../../build-settings.json','utf8'));
appendFileSync('../../trace.jsonl','executed\\n');
`);
  run('bun', ['install', '--lockfile-only', '--ignore-scripts'], resolve(root, 'packages/pure'));
  run('git', ['init']);
  const build = (extra = [], expected = true) => run(process.execPath, [nx, 'run', '@fixture/pure:repo-build', '--outputStyle=static', ...extra], root, expected);
  const executions = () => readFileSync(resolve(root, 'trace.jsonl'), 'utf8').trim().split('\n').length;
  build(); assert.equal(executions(), 1);
  const original = readFileSync(resolve(root, 'packages/pure/dist/result'), 'utf8');
  rmSync(resolve(root, 'packages/pure/dist'), { recursive: true });
  build(); assert.equal(executions(), 1); // Must restore, not rebuild.
  assert.equal(readFileSync(resolve(root, 'packages/pure/dist/result'), 'utf8'), original);
  put('packages/pure/input.txt', 'second'); build(); assert.equal(executions(), 2);
  const lock = readFileSync(resolve(root, 'packages/pure/bun.lock'), 'utf8');
  put('packages/pure/bun.lock', `${lock}\n`); build(); assert.equal(executions(), 3);
  put('build-settings.json', { value: 2 }); build(); assert.equal(executions(), 4);
  put('packages/pure/.env', 'SECRET_DO_NOT_PRINT=fixture\n');
  const refusal = build([], false);
  assert.ok(refusal.includes('Cached builds do not load dotenv'));
  assert.equal(executions(), 4);
  rmSync(resolve(root, 'packages/pure/.env'));
  build(); assert.equal(executions(), 4);
  const stable = readFileSync(resolve(root, 'packages/pure/dist/result'), 'utf8');
  build(['--skipNxCache']); assert.equal(executions(), 5);
  assert.equal(readFileSync(resolve(root, 'packages/pure/dist/result'), 'utf8'), stable);
  console.log('PASS: real local cache replay without execution; deleted output restored; source, lock and shared input invalidation; dotenv refusal; uncached equivalence.');
} finally { rmSync(root, { recursive: true, force: true }); }

if (process.argv.includes('--repository')) {
  const cache = resolve(repository, `.nx/cache-contracts-acceptance-${process.pid}`);
  const overrides = { NX_CACHE_DIRECTORY: cache };
  const args = [nx, 'run', '@supacloud/contracts:repo-build', '--outputStyle=static'];
  const output = resolve(repository, 'packages/contracts/dist');
  const snapshot = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) =>
    entry.isDirectory() ? snapshot(resolve(directory, entry.name), `${prefix}${entry.name}/`)
      : [[`${prefix}${entry.name}`, createHash('sha256').update(readFileSync(resolve(directory, entry.name))).digest('hex')]]);
  try {
    run(process.execPath, args, repository, true, overrides);
    const expected = snapshot(output);
    assert.ok(expected.length > 0);
    rmSync(output, { recursive: true });
    const hit = run(process.execPath, args, repository, true, overrides);
    assert.match(hit, /local cache|read the output from the cache/i);
    assert.deepEqual(snapshot(output), expected);
    run(process.execPath, [...args, '--skipNxCache'], repository, true, overrides);
    assert.deepEqual(snapshot(output), expected);
    mkdirSync(resolve(repository, '.nx/evidence'), { recursive: true });
    writeFileSync(resolve(repository, '.nx/evidence/contracts-cache.json'), JSON.stringify({ schemaVersion: 1, restored: true, uncachedEquivalent: true, files: expected }, null, 2));
    console.log('PASS: actual contracts package output restoration and uncached artifact equivalence.');
  } finally { rmSync(cache, { recursive: true, force: true }); }
}
