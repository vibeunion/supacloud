import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveEdgeRuntimeRecovery } from './recover-edge-runtime-release.mjs';

const commit = 'a'.repeat(40);
const recoveryInput = {
  repository: 'vibeunion/supacloud',
  ref: 'refs/heads/main',
  event: 'workflow_dispatch',
  tag: 'edge-runtime-v0.32.0',
  workflowCommit: commit,
};

function recoveryRunner(overrides = {}) {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key.startsWith('git rev-parse')) return overrides.sourceCommit ?? commit;
    if (key.startsWith('git show')) return overrides.packageJson ?? '{"version":"0.32.0"}';
    if (key.startsWith('gh release view')) {
      return overrides.release ?? JSON.stringify({
        tagName: 'edge-runtime-v0.32.0',
        isDraft: false,
        isPrerelease: false,
        assets: [],
      });
    }
    return '';
  };
}

test('accepts only an empty stable Edge Runtime release at the exact tagged commit', () => {
  assert.deepEqual(resolveEdgeRuntimeRecovery(recoveryInput, recoveryRunner()), {
    tag: 'edge-runtime-v0.32.0',
    sourceCommit: commit,
  });
});

test('rejects recovery when the release already has assets', () => {
  assert.throws(
    () => resolveEdgeRuntimeRecovery(recoveryInput, recoveryRunner({
      release: JSON.stringify({
        tagName: 'edge-runtime-v0.32.0',
        isDraft: false,
        isPrerelease: false,
        assets: [{ name: 'SHA256SUMS' }],
      }),
    })),
    /no assets/,
  );
});

test('rejects a tag whose package version does not match', () => {
  assert.throws(
    () => resolveEdgeRuntimeRecovery(recoveryInput, recoveryRunner({ packageJson: '{"version":"0.31.2"}' })),
    /does not match/,
  );
});
