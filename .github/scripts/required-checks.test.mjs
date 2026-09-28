import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const source = readFileSync(new URL('../workflows/management-api.yml', import.meta.url), 'utf8');
// These assertions deliberately track this workflow's block-style job layout.
// A layout change must update the test rather than silently dropping coverage.
const jobsStart = source.indexOf('\njobs:\n');
assert.notEqual(jobsStart, -1, 'Expected a top-level jobs block');
const jobsSource = source.slice(jobsStart + 1);
const headers = [...jobsSource.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)];
const jobs = new Map(headers.map((match, index) => [
  match[1], jobsSource.slice(match.index, headers[index + 1]?.index ?? jobsSource.length),
]));
assert.equal(jobs.size, headers.length, 'Duplicate job IDs');

function job(id) {
  const value = jobs.get(id);
  assert.ok(value, `Missing workflow job: ${id}`);
  return value;
}

const aggregate = job('required-checks');
const needsBlock = aggregate.match(/^ {4}needs:\n((?: {6}- [a-z0-9-]+\n)+)/m);
assert.ok(needsBlock, 'Expected an explicit dependency list');
const needs = [...needsBlock[1].matchAll(/^ {6}- ([a-z0-9-]+)$/gm)].map(match => match[1]);
const mappings = [...aggregate.matchAll(/^ {10}([A-Z_0-9]+): \$\{\{ needs\.([a-z0-9-]+)\.result \}\}$/gm)]
  .map(match => [match[1], match[2]]);
const runParts = aggregate.split('        run: |\n');
assert.equal(runParts.length, 2, 'Expected exactly one aggregate shell script');
const script = runParts[1].trimEnd().split('\n').map(line => {
  assert.ok(line === '' || line.startsWith('          '), 'Unexpected shell indentation');
  return line.slice(10);
}).join('\n');
const sorted = values => [...values].sort();

function runGate(overrides = {}) {
  const result = spawnSync('bash', ['-e', '-c', script], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ...Object.fromEntries(mappings.map(([key]) => [key, 'success'])), ...overrides },
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, 'Aggregate was terminated by a signal');
  return result;
}

test('Required Checks waits for every PR acceptance job, including standalone native PostgreSQL', () => {
  assert.match(aggregate, /^ {4}name: Required Checks$/m);
  assert.match(aggregate, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
  assert.doesNotMatch(aggregate, /continue-on-error/);
  // Only this explicitly push-only publisher is excluded; new PR jobs must be gated.
  assert.match(job('build-binaries'), /^ {4}if: github\.event_name == 'push' &&/m);
  const acceptance = [...jobs.keys()].filter(id => id !== 'required-checks' && id !== 'build-binaries');
  assert.ok(acceptance.includes('supacloud-lite-standalone-native'));
  assert.deepEqual(sorted(needs), sorted(acceptance));
});

test('each required dependency has exactly one result binding', () => {
  assert.deepEqual(sorted(mappings.map(([, id]) => id)), sorted(needs));
  assert.equal(new Set(mappings.map(([key]) => key)).size, mappings.length);
});

test('every result binding participates in the shell gate', () => {
  const consumed = [...script.matchAll(/"\$([A-Z_0-9]+)"/g)].map(match => match[1]);
  assert.deepEqual(sorted(consumed), sorted(mappings.map(([key]) => key)));
});

test('the CI script checks run this regression suite', () => {
  assert.match(job('docker-and-scripts-checks'), /^ {10}node --test \.github\/scripts\/required-checks\.test\.mjs$/m);
});

test('package checks use bounded high concurrency', () => {
  assert.match(job('package-checks'), /^ {6}max-parallel: 12$/m);
});

test('Windows Lite checks restore Bun cache before installation', () => {
  const windows = job('supacloud-lite-windows');
  assert.match(windows, /^ {6}- name: Restore Windows Bun package cache$/m);
  assert.match(windows, /^ {8}uses: actions\/cache@v6$/m);
  assert.match(windows, /^ {10}path: ~\/\.bun\/install\/cache$/m);
  assert.ok(windows.indexOf('Restore Windows Bun package cache') < windows.indexOf('Prepare Windows Lite dependencies'));
  assert.match(windows, /bun install --frozen-lockfile/);
  assert.match(windows, /bun run check/);
  assert.match(windows, /bun run \.\.\/\.\.\/scripts\/audit_dependencies\.ts/);
  assert.doesNotMatch(windows, /cache-hit|continue-on-error/);
});

test('binary builds remain downstream of the aggregate quality gate', () => {
  assert.match(job('build-binaries'), /^ {4}needs: \[required-checks\]$/m);
  assert.doesNotMatch(job('build-binaries'), /always\(\)|continue-on-error/);
});

test('Caddy caches never replace native build and smoke checks', () => {
  for (const id of ['caddy-edge-proxy-smoke', 'build-binaries']) {
    const source = job(id);
    assert.doesNotMatch(source.split(/^ {4}steps:/m)[0], /\$\{\{ runner\./);
    assert.ok(source.indexOf('Configure Caddy Go cache paths') >= 0);
    assert.ok(source.indexOf('Configure Caddy Go cache paths') < source.indexOf('Restore Caddy Go cache'));
    assert.ok(source.includes('echo "GOCACHE=$RUNNER_TEMP/caddy-go-build" >> "$GITHUB_ENV"'));
    assert.ok(source.includes('echo "GOMODCACHE=$RUNNER_TEMP/caddy-go-mod" >> "$GITHUB_ENV"'));
    assert.match(source, /path: \|\n {12}\$\{\{ env\.GOCACHE \}\}\n {12}\$\{\{ env\.GOMODCACHE \}\}/);
    assert.match(source, /hashFiles\('scripts\/build_supacloud_caddy\.sh', 'docker\/self-host\/caddy\/Dockerfile'\)/);
    assert.match(source, /go install github\.com\/caddyserver\/xcaddy\/cmd\/xcaddy@\$\{XCADDY_VERSION\}/);
    assert.match(source, /bash scripts\/build_supacloud_caddy\.sh/);
    assert.doesNotMatch(source, /cache-hit|continue-on-error/);
  }
  assert.match(job('caddy-edge-proxy-smoke'), /bash scripts\/test_supacloud_caddy_edge_proxy\.sh/);
});

test('the aggregate succeeds only when all required jobs succeed', () => {
  const result = runGate();
  assert.equal(result.status, 0, result.stderr);
});

for (const [variable, id] of mappings) {
  for (const state of ['failure', 'cancelled', 'skipped', '']) {
    test(`${id}: ${state || 'missing'} result rejects the aggregate`, () => {
      const result = runGate({ [variable]: state });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Required CI job did not succeed:/);
    });
  }
}
