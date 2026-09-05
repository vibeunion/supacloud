import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { syncCompilerDependency } from './sync-compiler-dependency.mjs';

function packagesWithRange(range, compilerVersion) {
  return {
    cliPackage: {
      name: '@supacloud/cli',
      dependencies: {
        '@supacloud/compiler': range,
        preserved: '^1.2.3',
      },
    },
    compilerPackage: {
      name: '@supacloud/compiler',
      version: compilerVersion,
    },
  };
}

describe('CLI compiler dependency sync', () => {
  test('updates the CLI range to the newly released compiler', () => {
    const packages = packagesWithRange('^0.2.0', '0.6.0');
    const synchronization = syncCompilerDependency(packages);

    assert.equal(synchronization.changed, true);
    assert.equal(synchronization.package.dependencies['@supacloud/compiler'], '^0.6.0');
    assert.equal(packages.cliPackage.dependencies['@supacloud/compiler'], '^0.2.0');
    assert.equal(synchronization.package.dependencies.preserved, '^1.2.3');
  });

  test('is idempotent for the current compiler version', () => {
    assert.equal(
      syncCompilerDependency(packagesWithRange('^0.6.0', '0.6.0')).changed,
      false,
    );
  });

  test('fails closed for a compiler version regression', () => {
    assert.throws(
      () => syncCompilerDependency(packagesWithRange('^0.6.0', '0.5.0')),
      /candidate 0\.5\.0 is below current lower bound \^0\.6\.0/,
    );
  });

  test('rejects unsupported ranges and prereleases', () => {
    assert.throws(
      () => syncCompilerDependency(packagesWithRange('~0.2.0', '0.6.0')),
      /unsupported dependency range/,
    );
    assert.throws(
      () => syncCompilerDependency(packagesWithRange('^0.2.0-beta.1', '0.6.0')),
      /prerelease versions are not supported/,
    );
    assert.throws(
      () => syncCompilerDependency(packagesWithRange('^0.2.0', '0.6.0-beta.1')),
      /prerelease versions are not supported/,
    );
  });
});
