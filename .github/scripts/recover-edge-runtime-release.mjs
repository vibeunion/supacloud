import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {object} RecoveryInput
 * @property {string | undefined} repository
 * @property {string | undefined} ref
 * @property {string | undefined} event
 * @property {string | undefined} tag
 * @property {string | undefined} workflowCommit
 */

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {string}
 */
const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();

// This runtime has no workspace package dependencies. Include its entire tree
// and the root configuration/manifest generator that can affect its artifacts.
export const EDGE_RUNTIME_BUILD_INPUTS = [
  'packages/edge-runtime',
  'package.json',
  'bun.lock',
  'bunfig.toml',
  '.npmrc',
  '.env',
  '.env.local',
  '.env.production',
  'tsconfig.json',
  'tsconfig.base.json',
  'scripts/generate_release_manifest.ts',
  'packages/management-api/src/release-manifest.ts',
];

/**
 * @param {RecoveryInput} input
 * @param {(command: string, args: readonly string[]) => string} [run]
 * @returns {{ tag: string, sourceCommit: string, tagCommit: string }}
 */
export function resolveEdgeRuntimeRecovery(input, run = execute) {
  if (input.repository !== 'vibeunion/supacloud'
    || input.ref !== 'refs/heads/main'
    || input.event !== 'workflow_dispatch') {
    throw new Error('Edge Runtime recovery requires an isolated manual run on main');
  }
  if (typeof input.tag !== 'string' || input.tag !== input.tag.trim()
    || !/^edge-runtime-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.tag)) {
    throw new Error('Recovery requires an exact stable Edge Runtime release tag');
  }
  const sourceCommit = run('git', ['rev-parse', '--verify', `refs/tags/${input.tag}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Invalid release commit');
  if (typeof input.workflowCommit !== 'string' || !/^[0-9a-f]{40}$/.test(input.workflowCommit)
    || run('git', ['rev-parse', 'HEAD']) !== input.workflowCommit) {
    throw new Error('Recovery checkout must match the signing workflow commit');
  }
  run('git', ['merge-base', '--is-ancestor', sourceCommit, 'HEAD']);
  const changedInputs = run('git', [
    'diff', '--name-only', sourceCommit, input.workflowCommit, '--', ...EDGE_RUNTIME_BUILD_INPUTS,
  ]);
  if (changedInputs !== '') {
    throw new Error(`Recovery build inputs differ from the tagged release: ${changedInputs}`);
  }
  const manifest = JSON.parse(run('git', ['show', `${sourceCommit}:packages/edge-runtime/package.json`]));
  if (`edge-runtime-v${manifest.version}` !== input.tag) {
    throw new Error('Release tag does not match the tagged package version');
  }
  const release = JSON.parse(run('gh', [
    'release', 'view', input.tag, '--repo', input.repository,
    '--json', 'tagName,isDraft,isPrerelease,assets',
  ]));
  if (release.tagName !== input.tag || release.isDraft !== false || release.isPrerelease !== false
    || !Array.isArray(release.assets) || release.assets.length !== 0) {
    throw new Error('Recovery requires an existing published stable release with no assets');
  }
  return { tag: input.tag, sourceCommit: input.workflowCommit, tagCommit: sourceCommit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = resolveEdgeRuntimeRecovery({
    repository: process.env['GITHUB_REPOSITORY'],
    ref: process.env['GITHUB_REF'],
    event: process.env['GITHUB_EVENT_NAME'],
    tag: process.env['RELEASE_TAG'],
    workflowCommit: process.env['GITHUB_SHA'],
  });
  appendFileSync(process.env['GITHUB_OUTPUT'] ?? '', `tag=${result.tag}\nsource_commit=${result.sourceCommit}\ntag_commit=${result.tagCommit}\n`);
}
