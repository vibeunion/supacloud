import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCachePolicy, scriptFingerprint, CONTRACTS_BUILD_SCRIPTS } from './cache-policy.mjs';
import { cacheContext } from './cache-key.mjs';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const scripts = JSON.parse(readFileSync(resolve(repository, 'packages/contracts/package.json'))).scripts;
const project = { name: '@supacloud/contracts', packageName: '@supacloud/contracts', root: 'packages/contracts', scripts };
test('only the reviewed contracts script contract enables caching', () => {
  assert.equal(scriptFingerprint(scripts), CONTRACTS_BUILD_SCRIPTS);
  assert.equal(buildCachePolicy(project).cache, true);
  for (const change of [{ name: 'other' }, { packageName: 'other' }, { root: 'packages/other' }, { scripts: { ...scripts, prebuild: 'side-effect' } }]) assert.equal(buildCachePolicy({ ...project, ...change }).cache, false);
  assert.ok(buildCachePolicy(project).inputs.some((input) => input.runtime?.includes('cache-key.mjs')));
});
test('environment, hidden config and runtime versions change cache identity without exposing values', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'cache-context-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'packages/contracts'), { recursive: true }); mkdirSync(resolve(root, 'home'));
  mkdirSync(resolve(root, 'xdg'));
  const env = { HOME: resolve(root, 'home'), XDG_CONFIG_HOME: resolve(root, 'xdg') };
  const key = cacheContext(root, 'packages/contracts', env, { bun: '1.4.2' });
  assert.equal(key, cacheContext(root, 'packages/contracts', env, { bun: '1.4.2' }));
  assert.notEqual(key, cacheContext(root, 'packages/contracts', { ...env, SECRET: 'not-for-logs' }, { bun: '1.4.2' }));
  assert.notEqual(key, cacheContext(root, 'packages/contracts', env, { bun: 'next' }));
  for (const file of ['.env.local', 'packages/contracts/.env', 'home/.bunfig.toml', 'xdg/.bunfig.toml']) {
    writeFileSync(resolve(root, file), 'secret=not-for-logs');
    const changed = cacheContext(root, 'packages/contracts', env, { bun: '1.4.2' });
    assert.notEqual(key, changed); assert.match(changed, /^[a-f0-9]{64}$/);
    rmSync(resolve(root, file));
  }
});
test('cache context refuses unreviewed projects', () => assert.throws(() => cacheContext(repository, '../other'), /No reviewed/));
