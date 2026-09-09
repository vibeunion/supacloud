import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareCommandPackage } from './prepare-command-package.mjs';

const siblings = new Map([
  ['@supacloud/contracts', { name: '@supacloud/contracts', version: '0.1.0' }],
  ['@supacloud/commands', { name: '@supacloud/commands', version: '0.1.0' }],
  ['@supacloud/db', { name: '@supacloud/db', version: '0.6.0' }],
]);
test('publication resolves local dependencies and overrides without mutating development manifests', () => {
  const input = {
    name: '@supacloud/elysia',
    dependencies: { '@supacloud/db': 'file:../db', '@supacloud/contracts': 'file:../contracts', jose: '^6.2.11' },
    overrides: { '@supacloud/contracts': 'file:../contracts' },
  };
  const result = prepareCommandPackage(input, siblings);
  assert.deepEqual(result.required, ['@supacloud/contracts@0.1.0', '@supacloud/db@0.6.0']);
  assert.deepEqual(result.package, {
    name: '@supacloud/elysia',
    dependencies: { '@supacloud/db': '0.6.0', '@supacloud/contracts': '0.1.0', jose: '^6.2.11' },
    overrides: { '@supacloud/contracts': '0.1.0' },
  });
  assert.equal(input.dependencies['@supacloud/db'], 'file:../db');
  assert.deepEqual(prepareCommandPackage({ name: '@supacloud/contracts' }, siblings).required, []);
});
test('malformed manifests, unknown paths and unstable versions cannot be published', () => {
  for (const manifest of [null, { name: 'x', dependencies: [] },
    { name: 'x', overrides: { '@supacloud/db': {} } },
    { name: 'x', dependencies: { '@supacloud/db': 'file:../../private' } },
    { name: 'x', dependencies: { '@supacloud/unknown': 'file:../unknown' } }]) {
    assert.throws(() => prepareCommandPackage(manifest, siblings));
  }
  assert.throws(() => prepareCommandPackage({ name: 'x', dependencies: { '@supacloud/db': 'file:../db' } },
    new Map([['@supacloud/db', { name: '@supacloud/db', version: '0.7.0-beta' }]])));
});
test('release order and preparation cover every package using local command dependencies', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  const contracts = workflow.indexOf('name: Publish command contracts');
  const commands = workflow.indexOf('name: Publish durable commands');
  const database = workflow.indexOf('name: Publish database governance');
  const app = workflow.indexOf('name: Publish app framework');
  const svelte = workflow.indexOf('name: Publish Svelte lifecycle');
  const elysia = workflow.indexOf('name: Publish elysia adapter');
  assert.ok(contracts > 0 && commands > contracts && database > commands && app > database && svelte > contracts && elysia > database);
  for (const name of ['commands', 'app', 'app-svelte', 'db', 'elysia']) {
    const block = workflow.split(`working-directory: packages/${name}\n`)[1]?.split('\n      - name:')[0];
    assert.ok(block);
    assert.match(block, /prepare-command-package\.mjs[\s\S]*bun install --lockfile-only[\s\S]*bun install --frozen-lockfile/);
  }
});
test('build fixtures use versioned dependencies without adding them to the runtime graph', () => {
  const input = {
    name: '@supacloud/elysia',
    dependencies: { '@supacloud/contracts': 'file:../contracts' },
    devDependencies: { '@supacloud/db': 'file:../db', '@supacloud/commands': 'file:../commands' },
  };
  const result = prepareCommandPackage(input, siblings);
  assert.deepEqual(result.required, ['@supacloud/contracts@0.1.0']);
  assert.deepEqual(result.package['devDependencies'], { '@supacloud/db': '0.6.0', '@supacloud/commands': '0.1.0' });
  assert.deepEqual(result.package['dependencies'], { '@supacloud/contracts': '0.1.0' });
});
test('clean CI builds local dependencies before checking command consumers', () => {
  const workflow = readFileSync(new URL('../workflows/management-api.yml', import.meta.url), 'utf8');
  for (const name of ['contracts', 'commands', 'app-svelte']) {
    assert.ok(workflow.includes(`working-directory: packages/${name}\n`));
  }
  for (const name of ['app', 'db', 'commands', 'app-svelte', 'elysia']) {
    const block = workflow.split(`working-directory: packages/${name}\n`)[1]?.split('\n          - name:')[0];
    assert.ok(block);
    assert.match(block, new RegExp(`build-command-dependencies\\.ts ${name}[\\s\\S]*bun install --frozen-lockfile`));
    if (name === 'elysia') assert.match(block, /generate:example[\s\S]*typecheck/);
  }
});
