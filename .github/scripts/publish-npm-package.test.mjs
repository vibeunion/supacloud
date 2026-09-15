import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { publishNpmPackage } from './publish-npm-package.mjs';

const registry = 'https://registry.npmjs.org';
/** @param {string} packageSpec */
const viewArgs = (packageSpec) => ['view', packageSpec, 'version', '--json', `--registry=${registry}`];
const publishArgs = ['publish', '--provenance', '--access', 'public', `--registry=${registry}`];

/** @param {string} packageSpec */
function npmNotFoundError(packageSpec) {
  return Object.assign(new Error(`npm view failed for ${packageSpec}`), {
    stderr: `npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${packageSpec}`,
  });
}

/** @param {Array<Error | { stdout: string, stderr: string }>} responses */
function recordingRunner(responses) {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    /** @param {string[]} arguments_ */
    runNpm: async (arguments_) => {
      calls.push(arguments_);
      const response = responses.shift();
      if (response === undefined) throw new Error('No npm fixture response remaining');
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe('retry-safe npm publishing', () => {
  test('skips publishing when the exact package version already exists', async () => {
    const runner = recordingRunner([{ stdout: '"0.14.4"\n', stderr: '' }]);

    const publication = await publishNpmPackage({
      name: '@supacloud/cli',
      version: '0.14.4',
      runNpm: runner.runNpm,
    });

    assert.equal(publication.status, 'already-published');
    assert.deepEqual(runner.calls, [
      viewArgs('@supacloud/cli@0.14.4'),
    ]);
  });

  test('publishes only after an explicit npm 404 response', async () => {
    const runner = recordingRunner([
      npmNotFoundError('@supacloud/admin@0.7.2'),
      { stdout: '+ @supacloud/admin@0.7.2\n', stderr: '' },
      { stdout: '"0.7.2"\n', stderr: '' },
    ]);

    const publication = await publishNpmPackage({
      name: '@supacloud/admin',
      version: '0.7.2',
      runNpm: runner.runNpm,
    });

    assert.equal(publication.status, 'published');
    assert.deepEqual(runner.calls, [
      viewArgs('@supacloud/admin@0.7.2'),
      publishArgs,
      viewArgs('@supacloud/admin@0.7.2'),
    ]);
  });

  test('accepts an explicit HTTP 404 without an npm error code', async () => {
    const notFound = Object.assign(new Error('npm view failed'), {
      stderr: 'npm error 404 Not Found',
    });
    const runner = recordingRunner([notFound, { stdout: '', stderr: '' }, { stdout: '"0.14.4"\n', stderr: '' }]);

    await publishNpmPackage({
      name: '@supacloud/cli',
      version: '0.14.4',
      runNpm: runner.runNpm,
    });

    assert.deepEqual(runner.calls.at(-1), viewArgs('@supacloud/cli@0.14.4'));
    assert.deepEqual(runner.calls.at(-2), publishArgs);
  });

  test('fails closed when an exact registry query returns another version', async () => {
    const runner = recordingRunner([{ stdout: '"0.14.3"\n', stderr: '' }]);

    await assert.rejects(
      publishNpmPackage({ name: '@supacloud/cli', version: '0.14.4', runNpm: runner.runNpm }),
      /npm returned 0\.14\.3 for exact package spec @supacloud\/cli@0\.14\.4/,
    );
    assert.equal(runner.calls.length, 1);
  });

  test('fails closed on registry authentication and network errors', async () => {
    for (const stderr of [
      'npm error code E401\nnpm error Incorrect or missing password.',
      'npm error code ENETWORK\nnpm error network request failed',
    ]) {
      const registryError = Object.assign(new Error('npm view failed'), { stderr });
      const runner = recordingRunner([registryError]);

      await assert.rejects(
        publishNpmPackage({ name: '@supacloud/cli', version: '0.14.4', runNpm: runner.runNpm }),
        (error) => error === registryError,
      );
      assert.equal(runner.calls.length, 1);
    }
  });

  test('retries npm view after publish until the version is visible', async () => {
    const runner = recordingRunner([
      npmNotFoundError('@supacloud/app@0.14.0'),
      { stdout: '+ @supacloud/app@0.14.0\n', stderr: '' },
      npmNotFoundError('@supacloud/app@0.14.0'),
      npmNotFoundError('@supacloud/app@0.14.0'),
      { stdout: '"0.14.0"\n', stderr: '' },
    ]);
    /** @type {number[]} */
    const sleeps = [];

    const publication = await publishNpmPackage({
      name: '@supacloud/app',
      version: '0.14.0',
      runNpm: runner.runNpm,
      delays: [1, 1],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    assert.equal(publication.status, 'published');
    assert.deepEqual(sleeps, [1, 1]);
    assert.equal(runner.calls.filter((arguments_) => arguments_[0] === 'view').length, 4);
  });

  test('fails closed when a successful publish never becomes visible', async () => {
    const runner = recordingRunner([
      npmNotFoundError('@supacloud/app@0.14.0'),
      { stdout: '+ @supacloud/app@0.14.0\n', stderr: 'npm notice provenance' },
      npmNotFoundError('@supacloud/app@0.14.0'),
    ]);

    await assert.rejects(
      publishNpmPackage({
        name: '@supacloud/app',
        version: '0.14.0',
        runNpm: runner.runNpm,
        delays: [],
        sleep: async () => {},
      }),
      /Registry does not yet list @supacloud\/app@0\.14\.0[\s\S]*npm notice provenance/,
    );
  });

  test('rerun skips an earlier success and resumes the later failed package', async () => {
    const publishedSpecs = new Set();
    let failAdminPublish = true;
    /** @param {{ name: string, version: string }} identity */
    const runnerFor = ({ name, version }) => /** @param {string[]} arguments_ */ async (arguments_) => {
      const packageSpec = `${name}@${version}`;
      if (arguments_[0] === 'view') {
        if (!publishedSpecs.has(packageSpec)) throw npmNotFoundError(packageSpec);
        return { stdout: JSON.stringify(version), stderr: '' };
      }
      if (name === '@supacloud/admin' && failAdminPublish) {
        throw new Error('simulated publisher outage');
      }
      publishedSpecs.add(packageSpec);
      return { stdout: `+ ${packageSpec}`, stderr: '' };
    };
    const cli = { name: '@supacloud/cli', version: '0.14.4' };
    const admin = { name: '@supacloud/admin', version: '0.7.2' };

    assert.equal((await publishNpmPackage({ ...cli, runNpm: runnerFor(cli) })).status, 'published');
    await assert.rejects(
      publishNpmPackage({ ...admin, runNpm: runnerFor(admin) }),
      /simulated publisher outage/,
    );

    failAdminPublish = false;
    assert.equal((await publishNpmPackage({ ...cli, runNpm: runnerFor(cli) })).status, 'already-published');
    assert.equal((await publishNpmPackage({ ...admin, runNpm: runnerFor(admin) })).status, 'published');
    assert.deepEqual(publishedSpecs, new Set(['@supacloud/cli@0.14.4', '@supacloud/admin@0.7.2']));
  });
});
