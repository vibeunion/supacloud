import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { EDGE_RUNTIME_BUILD_INPUTS, resolveEdgeRuntimeRecovery } from './recover-edge-runtime-release.mjs';

const tagCommit = 'a'.repeat(40);
const workflowCommit = 'b'.repeat(40);
const recoveryInput = {
  repository: 'vibeunion/supacloud',
  ref: 'refs/heads/main',
  event: 'workflow_dispatch',
  tag: 'edge-runtime-v0.32.0',
  workflowCommit,
};
const emptyRelease = {
  tagName: recoveryInput.tag, isDraft: false, isPrerelease: false, assets: [],
};

/**
 * @param {{ head?: string, tagCommit?: string, changed?: string, unmerged?: boolean,
 * version?: string, release?: Record<string, unknown> }} [overrides]
 */
function recoveryRunner(overrides = {}) {
  /** @param {string} command @param {readonly string[]} args */
  return (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return args[1] === 'HEAD' ? overrides.head ?? workflowCommit : overrides.tagCommit ?? tagCommit;
    }
    if (command === 'git' && args[0] === 'merge-base') {
      assert.deepEqual(args, ['merge-base', '--is-ancestor', tagCommit, 'HEAD']);
      if (overrides.unmerged) throw new Error('Tag is not on main');
      return '';
    }
    if (command === 'git' && args[0] === 'diff') {
      assert.deepEqual(args, ['diff', '--name-only', tagCommit, workflowCommit, '--', ...EDGE_RUNTIME_BUILD_INPUTS]);
      return overrides.changed ?? '';
    }
    if (command === 'git' && args[0] === 'show') {
      assert.deepEqual(args, ['show', `${tagCommit}:packages/edge-runtime/package.json`]);
      return JSON.stringify({ version: overrides.version ?? '0.32.0' });
    }
    if (command === 'gh') {
      assert.deepEqual(args, ['release', 'view', recoveryInput.tag, '--repo', recoveryInput.repository,
        '--json', 'tagName,isDraft,isPrerelease,assets']);
      return JSON.stringify({ ...emptyRelease, ...overrides.release });
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
}

test('Given identical tagged inputs, When recovering on newer main, Then build and sign main and preserve the tag identity', () => {
  assert.deepEqual(resolveEdgeRuntimeRecovery(recoveryInput, recoveryRunner()), {
    tag: recoveryInput.tag, sourceCommit: workflowCommit, tagCommit,
  });
});

test('Given changed build inputs, When recovering, Then reject before publication', () => {
  for (const changed of EDGE_RUNTIME_BUILD_INPUTS) {
    assert.throws(() => resolveEdgeRuntimeRecovery(recoveryInput, recoveryRunner({ changed })),
      /build inputs differ/);
  }
});

test('Given untrusted source or nonempty release, When recovering, Then fail closed', () => {
  for (const overrides of [
    { head: tagCommit }, { tagCommit: 'invalid' }, { unmerged: true }, { version: '0.31.2' },
    { release: { assets: [{ name: 'SHA256SUMS' }] } }, { release: { assets: null } },
    { release: { isDraft: true } }, { release: { isPrerelease: true } },
    { release: { tagName: 'edge-runtime-v0.31.2' } },
  ]) assert.throws(() => resolveEdgeRuntimeRecovery(recoveryInput, recoveryRunner(overrides)));
  for (const input of [
    { repository: 'other/repo' }, { event: 'push' }, { ref: 'refs/heads/other' },
    { tag: 'edge-runtime-v0.32.0\n' }, { tag: 'edge-runtime-v0.32.0-beta' },
    { workflowCommit: 'invalid' },
  ]) assert.throws(() => resolveEdgeRuntimeRecovery({ ...recoveryInput, ...input }, recoveryRunner()));
});

test('Given recovery workflow, When publishing, Then manifest and certificate use build commit without moving or overwriting release', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  const edge = workflow.split('\n  publish-edge-runtime-binaries:\n')[1]?.split('\n  publish-pgredis-runtime-binaries:\n')[0] ?? '';
  assert.ok(edge.includes('ref: ${{ needs.release-please.outputs.edge_runtime_source_commit || needs.release-please.outputs.edge_runtime_tag_name }}'));
  assert.ok(edge.includes('SOURCE_COMMIT: ${{ github.sha }}'));
  assert.ok(edge.includes('--source-digest "$(git rev-parse HEAD)"'));
  assert.ok(edge.includes('RECOVERY_TAG_COMMIT: ${{ needs.release-please.outputs.edge_runtime_tag_commit }}'));
  const upload = edge.split('if [[ -n "$RECOVERY_TAG" ]]; then')[1]?.split('\n          else')[0] ?? '';
  assert.ok(upload.includes('test "$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")" = "$RECOVERY_TAG_COMMIT"'));
  assert.ok(upload.includes('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'));
  assert.ok(upload.includes("'.assets | length'"));
  assert.ok(upload.includes('gh release upload "$RELEASE_TAG" packages/edge-runtime/dist/*'));
  assert.ok(!upload.includes('--clobber'));
});
