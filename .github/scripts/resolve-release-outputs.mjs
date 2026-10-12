import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @param {string} command @param {string[]} args */
const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();

/**
 * @param {{ outcome: string, outputs: Record<string, string>, repository: string,
 *   event: string, ref: string, sha: string }} input
 * @param {typeof execute} [run]
 * @returns {Record<string, string>}
 */
export function resolveReleaseOutputs(input, run = execute) {
  if (input.outcome === 'success') return input.outputs;
  if (input.outcome !== 'failure' || input.repository !== 'vibeunion/supacloud'
    || input.event !== 'push' || input.ref !== 'refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(input.sha)) {
    throw new Error('Release Please failed outside an eligible release push');
  }
  const json = (command, args) => JSON.parse(run(command, args));
  const prs = json('gh', ['api', `repos/${input.repository}/commits/${input.sha}/pulls`]);
  const releasePrs = prs.filter(pr => pr.merged_at && pr.merge_commit_sha === input.sha
    && pr.base?.ref === 'main' && pr.base?.repo?.full_name === input.repository
    && pr.head?.repo?.full_name === input.repository
    && pr.head?.ref === 'release-please--branches--main');
  if (releasePrs.length !== 1) throw new Error('Expected one merged Release Please PR for the exact commit');
  const read = (revision, file) => json('git', ['show', `${revision}:${file}`]);
  const current = read(input.sha, '.release-please-manifest.json');
  const previous = read(`${input.sha}^`, '.release-please-manifest.json');
  const config = read(input.sha, 'release-please-config.json');
  const outputs = {};
  const paths = [];
  // Recover only when every changed release is present and still unpublished downstream.
  // Never replay over existing or partially uploaded assets.
  for (const [path, version] of Object.entries(current)) {
    if (previous[path] === version) continue;
    const component = config.packages?.[path]?.component;
    if (!/^packages\/[a-z0-9-]+$/.test(path) || typeof component !== 'string'
      || !/^[a-z0-9-]+$/.test(component) || typeof version !== 'string'
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      throw new Error('Unsupported release identity');
    }
    const tag = `${component}-v${version}`;
    if (read(input.sha, `${path}/package.json`).version !== version
      || run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]) !== input.sha) {
      throw new Error(`Release source mismatch: ${tag}`);
    }
    const release = json('gh', ['api', `repos/${input.repository}/releases/tags/${tag}`]);
    if (release.tag_name !== tag || release.target_commitish !== input.sha
      || release.draft !== false || release.prerelease !== false || !release.published_at
      || !Array.isArray(release.assets) || release.assets.length !== 0) {
      throw new Error(`Release must be published, exact-source and empty: ${tag}`);
    }
    outputs[`${path}--release_created`] = 'true';
    outputs[`${path}--tag_name`] = tag;
    paths.push(path);
  }
  if (paths.length === 0) throw new Error('No changed releases to recover');
  // Repair only the lifecycle labels after all identities have been validated.
  run('gh', ['issue', 'edit', String(releasePrs[0].number), '--repo', input.repository,
    '--add-label', 'autorelease: tagged', '--remove-label', 'autorelease: pending']);
  return { ...outputs, releases_created: 'true', paths_released: JSON.stringify(paths) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputs = resolveReleaseOutputs({
    outcome: process.env.RELEASE_ACTION_OUTCOME ?? '',
    outputs: JSON.parse(process.env.RELEASE_ACTION_OUTPUTS ?? '{}'),
    repository: process.env.GITHUB_REPOSITORY ?? '',
    event: process.env.GITHUB_EVENT_NAME ?? '',
    ref: process.env.GITHUB_REF ?? '',
    sha: process.env.GITHUB_SHA ?? '',
  });
  for (const [key, value] of Object.entries(outputs)) {
    const delimiter = `output_${crypto.randomUUID()}`;
    appendFileSync(process.env.GITHUB_OUTPUT ?? '', `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}
