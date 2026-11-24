import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, probeTarball, waitForPublishedTarballs } from './wait-for-npm-tarball.mjs';

const spec = '@supacloud/cli@0.128.0';
const packumentUrl = 'https://registry.npmjs.org/@supacloud%2Fcli';
const tarballUrl = 'https://registry.npmjs.org/@supacloud/cli/-/cli-0.128.0.tgz';

/** A registry whose metadata and tarball become available on given probes. */
function registry({ metadataFrom = 1, tarballFrom = 1 } = {}) {
  const probes = { metadata: 0, tarball: 0 };
  const fetchImpl = async (url, init = {}) => {
    if (url === packumentUrl) {
      probes.metadata += 1;
      if (probes.metadata < metadataFrom) return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ versions: { '0.128.0': { dist: { tarball: tarballUrl } } } }),
      };
    }
    if (url === tarballUrl && init.method === 'HEAD') {
      probes.tarball += 1;
      return { ok: probes.tarball >= tarballFrom };
    }
    throw new Error(`Unexpected request: ${url} ${init.method ?? 'GET'}`);
  };
  return { fetchImpl, probes };
}

test('parses scoped and unscoped specs', () => {
  assert.deepEqual(parseSpec('@supacloud/cli@0.128.0'), { name: '@supacloud/cli', version: '0.128.0' });
  assert.deepEqual(parseSpec('supacloud@0.19.24'), { name: 'supacloud', version: '0.19.24' });
  assert.throws(() => parseSpec('no-version'), /Expected <name>@<version>/);
});

test('a visible version with a 404 tarball is not ready', async () => {
  // This is the regression: metadata propagated, tarball still missing, and the
  // job ran `bun install` against it.
  const { fetchImpl } = registry({ tarballFrom: 99 });
  assert.equal(await probeTarball(spec, fetchImpl), 'missing');
});

test('waits past a missing tarball and succeeds once it is downloadable', async () => {
  const { fetchImpl, probes } = registry({ tarballFrom: 3 });
  const result = await waitForPublishedTarballs({
    specs: [spec], attempts: 5, intervalMs: 0, fetchImpl, sleep: async () => {},
  });
  assert.deepEqual(result, { ok: true, pending: [], attempts: 3 });
  assert.equal(probes.tarball, 3);
});

test('a missing packument is retried, not treated as fatal', async () => {
  const { fetchImpl } = registry({ metadataFrom: 2 });
  const result = await waitForPublishedTarballs({
    specs: [spec], attempts: 3, intervalMs: 0, fetchImpl, sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test('reports the specs that never became downloadable', async () => {
  const { fetchImpl } = registry({ tarballFrom: 99 });
  const result = await waitForPublishedTarballs({
    specs: [spec], attempts: 3, intervalMs: 0, fetchImpl, sleep: async () => {},
  });
  assert.deepEqual(result, { ok: false, pending: [spec], attempts: 3 });
});

test('rejects an empty or malformed invocation', async () => {
  await assert.rejects(() => waitForPublishedTarballs({ specs: [] }), /specs must be a non-empty array/);
  await assert.rejects(
    () => waitForPublishedTarballs({ specs: [spec], attempts: 0 }),
    /attempts must be a positive integer/,
  );
});