import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nxExecutable } from './nx.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(resolve(tmpdir(), 'supacloud-cache-acceptance-'));
const nx = nxExecutable(repository);
const environment = { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true', NX_TUI: 'false', NX_INTERACTIVE: 'false' };
const put = (file, text) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), text); };
const run = (args, env = environment, success = true) => {
  const child = spawnSync(process.execPath, [nx, ...args], { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (child.error) throw child.error;
  if ((child.status === 0) !== success) throw new Error(`Unexpected cache acceptance exit: ${child.status}\n${child.stdout}\n${child.stderr}`);
  return child.stdout + child.stderr;
};
const built = ['run', '@supacloud/contracts:repo-build', '--outputStyle=static', '--parallel=1'];
const hit = (output) => /\[local cache\]|read the output from the cache|read output from cache/i.test(output);
function outputs(path = resolve(root, 'packages/contracts/dist'), prefix = '') {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = resolve(path, entry.name); const key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return Object.entries(outputs(file, `${key}/`));
    assert.ok(entry.isFile(), `Unexpected output symlink: ${key}`);
    return [[key, createHash('sha256').update(readFileSync(file)).digest('hex')]];
  }));
}
try {
  cpSync(resolve(repository, 'scripts/workspace'), resolve(root, 'scripts/workspace'), { recursive: true });
  for (const file of ['nx.json', 'tsconfig.base.json', 'package.json', 'bun.lock', '.gitignore', 'scripts/copy-dual-declarations.mjs']) {
    put(file, readFileSync(resolve(repository, file)));
  }
  cpSync(resolve(repository, 'packages/contracts'), resolve(root, 'packages/contracts'), { recursive: true,
    filter: (file) => !/(?:^|[/\\])(?:node_modules|dist)(?:[/\\]|$)/.test(file) });
  symlinkSync(resolve(repository, 'node_modules'), resolve(root, 'node_modules'), 'junction');
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root });
  assert.equal(initialized.status, 0);
  const cold = run(built); assert.equal(hit(cold), false, cold);
  const expected = outputs(); assert.ok(Object.keys(expected).length > 0);
  rmSync(resolve(root, 'packages/contracts/dist'), { recursive: true });
  const restored = run(built); assert.ok(hit(restored), restored);
  assert.deepEqual(outputs(), expected);
  put('packages/contracts/dist/stale.js', 'stale');
  assert.ok(hit(run(built))); assert.deepEqual(outputs(), expected);
  const invalidated = [];
  for (const file of ['packages/contracts/src/index.ts', 'packages/contracts/bun.lock', 'scripts/copy-dual-declarations.mjs']) {
    const original = readFileSync(resolve(root, file), 'utf8');
    put(file, original + (file.endsWith('.lock') ? '\n' : '\n// cache acceptance input change\n'));
    const output = run(built); assert.equal(hit(output), false, `${file}: ${output}`);
    invalidated.push(file); put(file, original);
  }
  put('packages/contracts/.env.local', 'SUPACLOUD_CACHE_ACCEPTANCE=changed\n');
  assert.equal(hit(run(built)), false); rmSync(resolve(root, 'packages/contracts/.env.local'));
  invalidated.push('ignored environment configuration');
  assert.equal(hit(run(built, { ...environment, SUPACLOUD_CACHE_ACCEPTANCE: 'different' })), false);
  invalidated.push('effective environment');
  const config = readFileSync(resolve(root, 'packages/contracts/tsconfig.json'), 'utf8');
  put('packages/contracts/tsconfig.json', '{invalid'); run(built, environment, false);
  put('packages/contracts/tsconfig.json', config);
  run(built); assert.deepEqual(outputs(), expected);
  assert.equal(hit(run([...built, '--skipNxCache'])), false);
  console.log(JSON.stringify({ passed: true, actualPackage: '@supacloud/contracts', restoredOutputs: Object.keys(expected).length,
    staleOutputsRemoved: true, invalidated, failureBlocked: true, explicitBypassRebuilt: true, remoteCache: false }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
