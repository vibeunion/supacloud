import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertPublishedDependencies, isNpmNotFoundError, prepareCommandPackage } from './prepare-command-package.mjs';
import { REGISTRY_RETRY_DELAYS_MS } from './npm-registry-visibility.mjs';

const siblings = new Map([
  ['@supacloud/cli', { name: '@supacloud/cli', version: '0.14.4' }],
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
test('publication resolves the admin CLI dependency before npm publish', () => {
  const input = {
    name: '@supacloud/admin',
    dependencies: { '@supacloud/cli': 'file:../cli', ssh2: '^1.17.0' },
  };
  const result = prepareCommandPackage(input, siblings);
  assert.deepEqual(result.required, ['@supacloud/cli@0.14.4']);
  assert.deepEqual(result.package, {
    name: '@supacloud/admin',
    dependencies: { '@supacloud/cli': '0.14.4', ssh2: '^1.17.0' },
  });
  assert.equal(input.dependencies['@supacloud/cli'], 'file:../cli');
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
  const cli = workflow.indexOf('name: Publish cli to NPM');
  const admin = workflow.indexOf('name: Publish admin to NPM');
  assert.ok(contracts > 0 && commands > contracts && database > commands && app > database && svelte > contracts && elysia > database);
  assert.ok(cli > 0 && admin > cli, 'admin must publish after its CLI dependency');
  assert.ok(contracts < workflow.indexOf('name: Publish supacloud-js'));
  for (const name of ['admin', 'commands', 'app', 'app-svelte', 'db', 'elysia', 'supacloud-js']) {
    const block = workflow.split(`working-directory: packages/${name}\n`)[1]?.split('\n      - name:')[0];
    assert.ok(block);
    assert.match(block, /prepare-command-package\.mjs[\s\S]*bun install --lockfile-only[\s\S]*bun install --frozen-lockfile/);
  }
});
test('recovery runs the command package graph after a tag-only release', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  assert.match(workflow, /recover_npm:\n\s+description: Retry missing command-package publications[\s\S]*?type: boolean/);
  assert.match(workflow,
    /publish-npm:\n\s+needs: release-please[\s\S]*?if: \$\{\{ always\(\) && \(needs\.release-please\.outputs\.releases_created == 'true' \|\| inputs\.recover_npm == true\) \}\}/);
  const contracts = workflow.indexOf('name: Publish command contracts');
  const commands = workflow.indexOf('name: Publish durable commands');
  assert.match(workflow.slice(contracts, commands), /inputs\.recover_npm == true/);
  for (const stepName of [
    'Publish supacloud-js to NPM',
    'Publish durable commands to NPM',
    'Publish database governance to NPM',
    'Publish app framework metadata to NPM',
    'Publish Svelte lifecycle binding to NPM',
    'Publish elysia adapter to NPM',
  ]) {
    const start = workflow.indexOf(`- name: ${stepName}`);
    const end = workflow.indexOf('\n      - name:', start + 1);
    assert.ok(start >= 0 && end > start, `missing publish step for ${stepName}`);
    assert.match(workflow.slice(start, end), /inputs\.recover_npm == true/);
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
  for (const name of ['app', 'db', 'commands', 'app-svelte', 'elysia', 'supacloud-js']) {
    const block = workflow.split(`working-directory: packages/${name}\n`)[1]?.split('\n          - name:')[0];
    assert.ok(block);
    assert.match(block, new RegExp(`build-command-dependencies\\.ts ${name}[\\s\\S]*bun install --frozen-lockfile`));
    if (name === 'elysia') assert.match(block, /generate:example[\s\S]*typecheck/);
  }
});

/** @param {string} spec */
function notFoundError(spec) {
  const error = /** @type {Error & { stderr?: string }} */ (new Error(`Command failed: npm view ${spec} version --json --registry=https://registry.npmjs.org`));
  error.stderr = `npm error code E404\nnpm error 404 No match found for version ${spec.split('@').at(-1)}`;
  return error;
}

test('just-published sibling 404s are retried until npm view succeeds', async () => {
  /** @type {number[]} */
  const views = [];
  /** @type {number[]} */
  const sleeps = [];
  await assertPublishedDependencies(['@supacloud/app@0.14.0'], {
    delays: [1, 1],
    sleep: async (/** @type {number} */ ms) => {
      sleeps.push(ms);
    },
    runNpm: async () => {
      views.push(views.length);
      if (views.length < 3) throw notFoundError('@supacloud/app@0.14.0');
      return { stdout: '"0.14.0"\n' };
    },
  });
  assert.deepEqual(views, [0, 1, 2]);
  assert.deepEqual(sleeps, [1, 1]);
});

test('persistent registry 404s still fail after retries', async () => {
  let views = 0;
  await assert.rejects(
    () => assertPublishedDependencies(['@supacloud/app@0.14.0'], {
      delays: [0],
      sleep: async () => {},
      runNpm: async () => {
        views += 1;
        throw notFoundError('@supacloud/app@0.14.0');
      },
    }),
    (error) => error instanceof Error && /Registry does not yet list @supacloud\/app@0\.14\.0/.test(error.message) && views === 2,
  );
});

test('non-404 registry errors fail immediately', async () => {
  let views = 0;
  await assert.rejects(
    () => assertPublishedDependencies(['@supacloud/app@0.14.0'], {
      delays: [1, 1],
      sleep: async () => {
        throw new Error('should not sleep');
      },
      runNpm: async () => {
        views += 1;
        throw new Error('EPERM');
      },
    }),
    { message: 'EPERM' },
  );
  assert.equal(views, 1);
});

test('lite publication builds sibling command packages before typecheck', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('- name: Publish SupaCloud Lite to NPM');
  const end = workflow.indexOf('\n      - name:', start + 1);
  const block = workflow.slice(start, end);
  assert.match(block, /build-command-dependencies\.ts supacloud-lite/);
  assert.match(block, /bun run check/);
});

test('later npm publish steps keep running after an earlier package fails', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  for (const stepName of [
    'Publish SupaCloud Lite to NPM',
    'Publish function adapter to NPM',
    'Publish app framework metadata to NPM',
    'Publish elysia adapter to NPM',
  ]) {
    const start = workflow.indexOf(`- name: ${stepName}`);
    const end = workflow.indexOf('\n      - name:', start + 1);
    assert.ok(start >= 0 && end > start, `missing publish step for ${stepName}`);
    assert.match(workflow.slice(start, end), /if: \$\{\{ always\(\) && \(/);
  }
});

test('publish-npm packages declare a GitHub repository URL for provenance', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  const job = workflow.split('\n  publish-npm:\n')[1]?.split('\n  sync-')[0];
  assert.ok(job);
  const directories = [...job.matchAll(/working-directory: packages\/([^\n]+)/g)].flatMap((match) => match[1] ? [match[1]] : []);
  assert.ok(directories.includes('function-adapter'));
  for (const name of directories) {
    const pkg = JSON.parse(readFileSync(new URL(`../../packages/${name}/package.json`, import.meta.url), 'utf8'));
    assert.ok(/github\.com\/vibeunion\/supacloud/.test(String(pkg.repository?.url ?? '')), name);
  }
});

test('registry retries wait long enough for provenance visibility', () => {
  assert.ok(REGISTRY_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0) >= 10 * 60 * 1000);
});
