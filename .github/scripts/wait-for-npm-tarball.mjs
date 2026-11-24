/**
 * Wait until a published npm package is actually downloadable.
 *
 * `publish-npm` and the dependency-sync jobs run in the same workflow run, and
 * npm makes the packument (registry metadata) visible before the tarball is
 * replicated. Checking only `npm view <spec> version` is therefore not enough:
 * the sync job then runs `bun install` against a version whose tarball still
 * answers 404 and the job fails on a package that publish successfully seconds
 * earlier.
 *
 * This waits for both signals, with a bounded budget, and reports which spec is
 * still missing instead of failing with a bare 404 from bun.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';

/** `@supacloud/cli@0.128.0` -> `{ name: '@supacloud/cli', version: '0.128.0' }`. */
export function parseSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) throw new Error(`Expected <name>@<version>, received ${spec}`);
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!name || !version) throw new Error(`Expected <name>@<version>, received ${spec}`);
  return { name, version };
}

/**
 * One probe of the registry.
 *
 * Returns `'ready'` only when the version exists *and* its tarball responds to a
 * HEAD request, `'missing'` when either signal is absent.
 */
export async function probeTarball(spec, fetchImpl = fetch) {
  const { name, version } = parseSpec(spec);
  const packumentUrl = `${REGISTRY}/${name.replace('/', '%2F')}`;
  let tarball;
  try {
    const response = await fetchImpl(packumentUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) return 'missing';
    const packument = await response.json();
    tarball = packument?.versions?.[version]?.dist?.tarball;
  } catch {
    return 'missing';
  }
  if (typeof tarball !== 'string' || tarball.length === 0) return 'missing';
  try {
    const head = await fetchImpl(tarball, { method: 'HEAD' });
    return head.ok ? 'ready' : 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * Poll every spec until it is downloadable or the budget runs out.
 *
 * @returns {Promise<{ ok: boolean, pending: string[], attempts: number }>}
 */
export async function waitForPublishedTarballs(options = {}) {
  const {
    specs,
    attempts = 24,
    intervalMs = 5_000,
    fetchImpl = fetch,
    sleep = delay,
    log = () => {},
  } = options;
  if (!Array.isArray(specs) || specs.length === 0) throw new Error('specs must be a non-empty array');
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer');

  let pending = [...specs];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const results = await Promise.all(pending.map(async (spec) => ({
      spec,
      state: await probeTarball(spec, fetchImpl),
    })));
    pending = results.filter((entry) => entry.state !== 'ready').map((entry) => entry.spec);
    if (pending.length === 0) return { ok: true, pending: [], attempts: attempt };
    log(`attempt ${attempt}/${attempts}: not downloadable yet: ${pending.join(', ')}`);
    if (attempt < attempts) await sleep(intervalMs);
  }
  return { ok: false, pending, attempts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const specs = process.argv.slice(2).filter((value) => value.length > 0);
  if (specs.length === 0) {
    console.error('Usage: wait-for-npm-tarball.mjs <name>@<version> [...]');
    process.exit(2);
  }
  const config = {
    specs,
    ...(process.env.NPM_TARBALL_ATTEMPTS ? { attempts: Number(process.env.NPM_TARBALL_ATTEMPTS) } : {}),
    ...(process.env.NPM_TARBALL_INTERVAL_MS ? { intervalMs: Number(process.env.NPM_TARBALL_INTERVAL_MS) } : {}),
    log: (message) => console.error(message),
  };
  const result = await waitForPublishedTarballs(config);
  if (!result.ok) {
    console.error(`Published tarball is still not downloadable after ${result.attempts} attempts: ${result.pending.join(', ')}`);
    process.exit(1);
  }
  console.log(`Downloadable after ${result.attempts} attempt(s): ${specs.join(', ')}`);
}