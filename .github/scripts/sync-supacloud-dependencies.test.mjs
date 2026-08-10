import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { syncSupacloudDependencies } from './sync-supacloud-dependencies.mjs';

const currentPackages = {
  supacloudPackage: {
    name: 'supacloud',
    dependencies: {
      '@supacloud/cli': '^0.14.3',
      '@supacloud/admin': '^0.7.1',
      preserved: '^1.2.3',
    },
  },
  cliPackage: { name: '@supacloud/cli', version: '0.14.4' },
  adminPackage: { name: '@supacloud/admin', version: '0.7.2' },
};

describe('SupaCloud umbrella dependency sync', () => {
  test('updates both managed ranges and preserves unrelated package content', () => {
    const synchronization = syncSupacloudDependencies(currentPackages);

    assert.equal(synchronization.changed, true);
    assert.deepEqual(synchronization.package.dependencies, {
      '@supacloud/cli': '^0.14.4',
      '@supacloud/admin': '^0.7.2',
      preserved: '^1.2.3',
    });
    assert.equal(currentPackages.supacloudPackage.dependencies['@supacloud/cli'], '^0.14.3');
  });

  test('is idempotent when both dependency ranges are synchronized', () => {
    const synchronized = {
      ...currentPackages,
      supacloudPackage: {
        ...currentPackages.supacloudPackage,
        dependencies: {
          ...currentPackages.supacloudPackage.dependencies,
          '@supacloud/cli': '^0.14.4',
          '@supacloud/admin': '^0.7.2',
        },
      },
    };

    assert.equal(syncSupacloudDependencies(synchronized).changed, false);
  });

  test('rejects malformed candidate versions', () => {
    assert.throws(
      () => syncSupacloudDependencies({
        ...currentPackages,
        cliPackage: { version: 'latest' },
      }),
      /@supacloud\/cli has an invalid version/,
    );
  });

  test('keeps Release Please and the post-publish sync workflow separated', () => {
    const config = JSON.parse(readFileSync(new URL('../../release-please-config.json', import.meta.url)));
    const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');

    assert.equal(config.packages['packages/cli']['extra-files'], undefined);
    assert.equal(config.packages['packages/admin']['extra-files'], undefined);
    assert.match(workflow, /sync-supacloud-dependencies:\n/);
    assert.match(workflow, /needs: \[release-please, publish-npm\]/);
    assert.match(workflow, /node \.github\/scripts\/sync-supacloud-dependencies\.mjs/);
    assert.match(workflow, /bun install --lockfile-only --registry https:\/\/registry\.npmjs\.org/);
    assert.match(workflow, /git add packages\/supacloud\/package\.json packages\/supacloud\/bun\.lock/);
    assert.doesNotMatch(workflow, /bun add --no-save '@supacloud\/cli@file:\.\.\/cli'/);

    const packageChecks = readFileSync(new URL('../workflows/management-api.yml', import.meta.url), 'utf8');
    assert.match(packageChecks, /working-directory: packages\/supacloud\n\s+run: \|\n\s+bun install --frozen-lockfile/);
    assert.doesNotMatch(packageChecks, /supacloud-install-mode/);
  });
});
