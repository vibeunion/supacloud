import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { selectSupacloudInstallMode } from './supacloud-install-mode.mjs';

const staleReleaseContent = {
  supacloudPackage: {
    dependencies: {
      '@supacloud/cli': '^0.13.0',
      '@supacloud/admin': '^0.7.0',
    },
  },
  cliPackage: { version: '0.13.0' },
  adminPackage: { version: '0.7.0' },
  lockfile: [
    '"@supacloud/cli": ["@supacloud/cli@0.12.0"]',
    '"@supacloud/admin": ["@supacloud/admin@0.6.0"]',
  ].join('\n'),
};

function select(context, content = staleReleaseContent) {
  return selectSupacloudInstallMode({ ...context, ...content });
}

describe('SupaCloud release install mode', () => {
  test('uses local candidates for a stale Release Please commit pushed to main', () => {
    assert.equal(select({
      eventName: 'push',
      ref: 'refs/heads/main',
      prAuthor: '',
      headRef: '',
    }), 'local-candidate');
  });

  test('uses local candidates for a stale Release Please bot pull request', () => {
    assert.equal(select({
      eventName: 'pull_request',
      ref: 'refs/pull/487/merge',
      prAuthor: 'github-actions[bot]',
      headRef: 'release-please--branches--main',
    }), 'local-candidate');
  });

  test('keeps every untrusted event on the frozen install path', () => {
    const untrustedContexts = [
      {
        eventName: 'pull_request',
        ref: 'refs/pull/487/merge',
        prAuthor: 'zuohuadong',
        headRef: 'codex/fix-release-lockfile-validation',
      },
      {
        eventName: 'push',
        ref: 'refs/heads/dev',
        prAuthor: '',
        headRef: '',
      },
      {
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/main',
        prAuthor: '',
        headRef: '',
      },
      {
        eventName: 'pull_request',
        ref: 'refs/pull/487/merge',
        prAuthor: 'github-actions[bot]',
        headRef: 'codex/generated-change',
      },
      {
        eventName: 'pull_request',
        ref: 'refs/pull/487/merge',
        prAuthor: 'github-actions[bot]',
        headRef: 'release-please--branches--dev',
      },
      {
        eventName: 'pull_request',
        ref: 'refs/pull/487/merge',
        prAuthor: 'zuohuadong',
        headRef: 'release-please--branches--main',
      },
    ];

    for (const context of untrustedContexts) {
      assert.equal(select(context), 'frozen', JSON.stringify(context));
    }
  });

  test('keeps a synchronized lockfile on the frozen install path', () => {
    assert.equal(select({
      eventName: 'push',
      ref: 'refs/heads/main',
      prAuthor: '',
      headRef: '',
    }, {
      ...staleReleaseContent,
      lockfile: [
        '"@supacloud/cli": ["@supacloud/cli@0.13.0"]',
        '"@supacloud/admin": ["@supacloud/admin@0.7.0"]',
      ].join('\n'),
    }), 'frozen');
  });

  test('does not treat a prerelease locator as the exact lockfile candidate', () => {
    assert.equal(select({
      eventName: 'push',
      ref: 'refs/heads/main',
      prAuthor: '',
      headRef: '',
    }, {
      ...staleReleaseContent,
      lockfile: [
        '"@supacloud/cli": ["@supacloud/cli@0.13.0-beta.1"]',
        '"@supacloud/admin": ["@supacloud/admin@0.7.0"]',
      ].join('\n'),
    }), 'local-candidate');
  });

  test('keeps mismatched local package versions on the frozen install path', () => {
    for (const dependencies of [
      {
        '@supacloud/cli': '^0.12.0',
        '@supacloud/admin': '^0.7.0',
      },
      {
        '@supacloud/cli': '^0.13.0',
        '@supacloud/admin': '^0.6.0',
      },
    ]) {
      assert.equal(select({
        eventName: 'push',
        ref: 'refs/heads/main',
        prAuthor: '',
        headRef: '',
      }, {
        ...staleReleaseContent,
        supacloudPackage: { dependencies },
      }), 'frozen');
    }
  });

  test('keeps the workflow wired to the tested selector', () => {
    const workflow = readFileSync(new URL('../workflows/management-api.yml', import.meta.url), 'utf8');

    assert.match(
      workflow,
      /install_mode="\$\(node \.\.\/\.\.\/\.github\/scripts\/supacloud-install-mode\.mjs\)"/,
    );
    assert.match(workflow, /node --check \.github\/scripts\/supacloud-install-mode\.mjs/);
    assert.match(workflow, /node --test \.github\/scripts\/supacloud-install-mode\.test\.mjs/);
    assert.doesNotMatch(workflow, /content_install_mode=/);
  });
});
