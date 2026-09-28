import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();

export function resolveManagementRecovery(input, run = execute) {
  if (input.repository !== 'vibeunion/supacloud'
    || input.ref !== 'refs/heads/main'
    || input.event !== 'workflow_dispatch'
    || input.recoverNpm === 'true') {
    throw new Error('Management recovery requires an isolated manual run on main');
  }
  if (typeof input.tag !== 'string' || input.tag !== input.tag.trim()
    || !/^management-api-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.tag)) {
    throw new Error('Recovery requires an exact stable Management release tag');
  }
  const sourceCommit = run('git', ['rev-parse', '--verify', `refs/tags/${input.tag}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Invalid release commit');
  if (sourceCommit !== input.workflowCommit) {
    throw new Error('Historical recovery requires a provenance protocol upgrade: the tag commit differs from the signing workflow commit');
  }
  run('git', ['merge-base', '--is-ancestor', sourceCommit, 'HEAD']);
  const manifest = JSON.parse(run('git', ['show', `${sourceCommit}:packages/management-api/package.json`]));
  if (`management-api-v${manifest.version}` !== input.tag) {
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
  return { tag: input.tag, sourceCommit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = resolveManagementRecovery({
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    event: process.env.GITHUB_EVENT_NAME,
    recoverNpm: process.env.RECOVER_NPM,
    tag: process.env.RELEASE_TAG,
    workflowCommit: process.env.GITHUB_SHA,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${result.tag}\nsource_commit=${result.sourceCommit}\n`);
}
