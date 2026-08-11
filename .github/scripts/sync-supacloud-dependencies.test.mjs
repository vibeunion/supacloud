import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { syncSupacloudDependencies } from './sync-supacloud-dependencies.mjs';

const currentPackages = {
  supacloudPackage: {
    name: 'supacloud',
    private: false,
    dependencies: {
      '@supacloud/cli': '^0.13.3',
      '@supacloud/admin': '^0.6.1',
      preserved: '^1.2.3',
    },
  },
  cliPackage: { name: '@supacloud/cli', version: '0.14.4' },
  adminPackage: { name: '@supacloud/admin', version: '0.7.2' },
};

function packagesWithRanges(cliRange, adminRange, cliVersion, adminVersion) {
  return {
    supacloudPackage: {
      name: 'supacloud',
      dependencies: {
        '@supacloud/cli': cliRange,
        '@supacloud/admin': adminRange,
        preserved: '^1.2.3',
      },
    },
    cliPackage: { version: cliVersion },
    adminPackage: { version: adminVersion },
  };
}

describe('SupaCloud umbrella dependency sync', () => {
  test('updates both managed ranges and preserves unrelated package content', () => {
    const originalPackages = structuredClone(currentPackages);
    const synchronization = syncSupacloudDependencies(currentPackages);

    assert.equal(synchronization.changed, true);
    assert.deepEqual(synchronization.package.dependencies, {
      '@supacloud/cli': '^0.14.4',
      '@supacloud/admin': '^0.7.2',
      preserved: '^1.2.3',
    });
    assert.equal(synchronization.package.private, false);
    assert.deepEqual(currentPackages, originalPackages);
  });

  test('keeps the CLI range when the candidate precedence is unchanged', () => {
    const packages = packagesWithRanges('^0.14.4', '^0.7.6', '0.14.4', '0.7.6');
    assert.equal(syncSupacloudDependencies(packages).changed, false);
  });

  test('advances the CLI lower bound for every newer stable version', () => {
    for (const version of ['0.14.5', '0.15.0']) {
      const packages = packagesWithRanges('^0.14.4', '^0.7.6', version, '0.7.6');
      const synchronization = syncSupacloudDependencies(packages);

      assert.equal(synchronization.changed, true);
      assert.equal(synchronization.package.dependencies['@supacloud/cli'], `^${version}`);
      assert.equal(packages.supacloudPackage.dependencies['@supacloud/cli'], '^0.14.4');
    }
  });

  test('rejects a CLI candidate below the ^0.14.4 lower bound', () => {
    const packages = packagesWithRanges('^0.14.4', '^0.7.6', '0.14.3', '0.7.6');
    assert.throws(() => syncSupacloudDependencies(packages), /candidate 0\.14\.3 is below current lower bound \^0\.14\.4/);
  });

  test('keeps the Admin range when the candidate precedence is unchanged', () => {
    const packages = packagesWithRanges('^0.14.4', '^0.7.6', '0.14.4', '0.7.6');
    assert.equal(syncSupacloudDependencies(packages).changed, false);
  });

  test('advances the Admin lower bound for every newer stable version', () => {
    for (const version of ['0.7.7', '0.8.0']) {
      const packages = packagesWithRanges('^0.14.4', '^0.7.6', '0.14.4', version);
      const synchronization = syncSupacloudDependencies(packages);

      assert.equal(synchronization.changed, true);
      assert.equal(synchronization.package.dependencies['@supacloud/admin'], `^${version}`);
    }
  });

  test('rejects an Admin candidate below the ^0.7.6 lower bound', () => {
    const packages = packagesWithRanges('^0.14.4', '^0.7.6', '0.14.4', '0.7.5');
    assert.throws(() => syncSupacloudDependencies(packages), /candidate 0\.7\.5 is below current lower bound \^0\.7\.6/);
  });

  test('advances lower bounds consistently for 1.x and 0.0.x versions', () => {
    for (const version of ['1.2.4', '1.99.0', '2.0.0']) {
      const synchronization = syncSupacloudDependencies(
        packagesWithRanges('^1.2.3', '^0.7.6', version, '0.7.6'),
      );
      assert.equal(synchronization.package.dependencies['@supacloud/cli'], `^${version}`);
    }
    assert.throws(
      () => syncSupacloudDependencies(packagesWithRanges('^1.2.3', '^0.7.6', '1.2.2', '0.7.6')),
      /candidate 1\.2\.2 is below current lower bound \^1\.2\.3/,
    );

    assert.equal(syncSupacloudDependencies(
      packagesWithRanges('^0.0.4', '^0.7.6', '0.0.4', '0.7.6'),
    ).changed, false);

    const nextPatch = syncSupacloudDependencies(
      packagesWithRanges('^0.0.4', '^0.7.6', '0.0.5', '0.7.6'),
    );
    assert.equal(nextPatch.package.dependencies['@supacloud/cli'], '^0.0.5');
    assert.throws(
      () => syncSupacloudDependencies(packagesWithRanges('^0.0.4', '^0.7.6', '0.0.3', '0.7.6')),
      /candidate 0\.0\.3 is below current lower bound \^0\.0\.4/,
    );
  });

  test('rejects malformed candidate versions', () => {
    for (const version of [
      'latest',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-',
      '1.2.3-alpha..1',
      '1.2.3-alpha.',
      '1.2.3-01',
      '1.2.3+build..1',
    ]) {
      assert.throws(
        () => syncSupacloudDependencies({
          ...currentPackages,
          cliPackage: { version },
        }),
        /@supacloud\/cli has an invalid version/,
      );
    }
  });

  test('ignores build metadata when comparing precedence', () => {
    const packages = packagesWithRanges(
      '^0.14.4+base.1',
      '^0.7.6',
      '0.14.4+build.5',
      '0.7.6+sha.5114f85',
    );

    assert.equal(syncSupacloudDependencies(packages).changed, false);
  });

  test('fails closed for unsupported ranges and prerelease versions', () => {
    for (const cliRange of ['~0.14.4', '0.14.4', 'workspace:*', '^0.14']) {
      const packages = packagesWithRanges(cliRange, '^0.7.6', '0.14.5', '0.7.6');
      assert.throws(() => syncSupacloudDependencies(packages), /unsupported dependency range/);
    }

    assert.throws(
      () => syncSupacloudDependencies(packagesWithRanges('^0.14.4-beta.1', '^0.7.6', '0.14.5', '0.7.6')),
      /prerelease versions are not supported/,
    );
    assert.throws(
      () => syncSupacloudDependencies(packagesWithRanges('^0.14.4', '^0.7.6', '0.14.5-beta.1', '0.7.6')),
      /prerelease versions are not supported/,
    );
  });

  test('keeps Release Please and the post-publish sync workflow separated', () => {
    const config = JSON.parse(readFileSync(new URL('../../release-please-config.json', import.meta.url)));
    const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');

    assert.equal(config.packages['packages/cli']['extra-files'], undefined);
    assert.equal(config.packages['packages/admin']['extra-files'], undefined);
    assert.match(workflow, /sync-supacloud-dependencies:\n/);
    assert.match(workflow, /needs: \[release-please, publish-npm\]/);
    assert.match(workflow, /id: synchronize/);
    assert.match(workflow, /if ! sync_output="\$\(node \.github\/scripts\/sync-supacloud-dependencies\.mjs\)"; then\n\s+echo "Dependency synchronization failed\." >&2\n\s+exit 1\n\s+fi/);
    assert.match(workflow, /changed=true\|changed=false/);
    assert.match(workflow, /printf '%s\\n' "\$sync_output" >> "\$GITHUB_OUTPUT"/);
    assert.match(workflow, /- name: Wait for published dependencies\n\s+if: \$\{\{ steps\.synchronize\.outputs\.changed == 'true' \}\}/);
    assert.match(workflow, /- name: Regenerate and verify umbrella lockfile\n\s+if: \$\{\{ steps\.synchronize\.outputs\.changed == 'true' \}\}/);
    assert.match(workflow, /- name: Open dependency synchronization PR\n\s+if: \$\{\{ steps\.synchronize\.outputs\.changed == 'true' \}\}/);
    const synchronizeIndex = workflow.indexOf('- name: Synchronize umbrella dependencies');
    const waitIndex = workflow.indexOf('- name: Wait for published dependencies');
    const lockIndex = workflow.indexOf('- name: Regenerate and verify umbrella lockfile');
    const pullRequestIndex = workflow.indexOf('- name: Open dependency synchronization PR');
    assert.ok(synchronizeIndex < waitIndex);
    assert.ok(waitIndex < lockIndex);
    assert.ok(lockIndex < pullRequestIndex);
    assert.match(workflow, /bun install --lockfile-only --registry https:\/\/registry\.npmjs\.org/);
    assert.match(workflow, /require\('\.\.\/\$package_name\/package\.json'\)\.version/);
    assert.match(workflow, /require\('\.\/node_modules\/@supacloud\/\$package_name\/package\.json'\)\.version/);
    assert.match(workflow, /Installed @supacloud\/\$package_name version \$installed does not match published sibling version \$expected/);
    assert.match(workflow, /git add packages\/supacloud\/package\.json packages\/supacloud\/bun\.lock/);
    assert.doesNotMatch(workflow, /sync-supacloud-dependencies\.mjs \|\| true/);
    assert.doesNotMatch(workflow, /bun add --no-save '@supacloud\/cli@file:\.\.\/cli'/);

    const packageChecks = readFileSync(new URL('../workflows/management-api.yml', import.meta.url), 'utf8');
    assert.match(packageChecks, /working-directory: packages\/supacloud\n\s+run: \|\n\s+bun install --frozen-lockfile/);
    assert.doesNotMatch(packageChecks, /supacloud-install-mode/);
  });
});
