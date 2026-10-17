import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateReleaseIdentity } from './validate-release-identity.mjs';

/** @param {string} command @param {string[]} args */
const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();

/**
 * @param {{ outcome: string, outputs: Record<string, string>, repository: string,
 *   event: string, ref: string, sha: string }} input
 * @param {typeof execute} [run]
 * @returns {Record<string, string>}
 */
export function resolveReleaseOutputs(input, run = execute) {
  if (input.outcome === 'success') {
    if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new Error('Invalid release source commit');
    /** @param {string} file */
    const read = file => JSON.parse(run('git', ['show', `${input.sha}:${file}`]));
    const current = read('.release-please-manifest.json');
    const config = read('release-please-config.json');
    const released = Object.entries(input.outputs)
      .filter(([key, value]) => key.endsWith('--release_created') && value === 'true')
      .map(([key]) => key.slice(0, -'--release_created'.length));
    const declared = JSON.parse(input.outputs['paths_released'] || '[]');
    if (!Array.isArray(declared) || new Set(declared).size !== declared.length
      || declared.length !== released.length || declared.some(path => !released.includes(path))
      || (input.outputs['releases_created'] === 'true') !== (released.length > 0)) {
      throw new Error('Inconsistent release output inventory');
    }
    for (const path of released) {
      // A delayed release from another commit cannot use this event's parent
      // manifest to establish completeness. Recover it explicitly instead.
      if (input.outputs[`${path}--sha`] !== input.sha) {
        throw new Error(`Release output source mismatch: ${path}`);
      }
      // Validate paths before using them in a git object lookup.
      validateReleaseIdentity(path, current[path], config, current[path], input.outputs[`${path}--tag_name`]);
      validateReleaseIdentity(path, current[path], config, read(`${path}/package.json`).version,
        input.outputs[`${path}--tag_name`]);
      if (input.outputs[`${path}--version`] !== undefined
        && input.outputs[`${path}--version`] !== current[path]) {
        throw new Error(`Release output version mismatch: ${path}`);
      }
    }
    // Dispatch with no new releases is an intentional npm-only retry. Normal
    // pushes (and dispatches creating releases) must cover every manifest bump.
    if (input.event === 'push' || released.length > 0) {
      const previous = JSON.parse(run('git', ['show', `${input.sha}^:.release-please-manifest.json`]));
      for (const [path, version] of Object.entries(current)) {
        if (previous[path] !== version && !released.includes(path)) {
          throw new Error(`Missing changed release output: ${path}`);
        }
      }
    }
    return input.outputs;
  }
  if (input.outcome !== 'failure' || input.repository !== 'vibeunion/supacloud'
    || input.event !== 'push' || input.ref !== 'refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(input.sha)) {
    throw new Error('Release Please failed outside an eligible release push');
  }
  /** @param {string} command @param {string[]} args */
  const json = (command, args) => JSON.parse(run(command, args));
  /** @type {Array<{ number: number, merged_at?: string, merge_commit_sha?: string,
   * base?: { ref?: string, repo?: { full_name?: string } },
   * head?: { ref?: string, repo?: { full_name?: string } } }>} */
  const prs = json('gh', ['api', `repos/${input.repository}/commits/${input.sha}/pulls`]);
  const releasePrs = prs.filter(pr => pr.merged_at && pr.merge_commit_sha === input.sha
    && pr.base?.ref === 'main' && pr.base?.repo?.full_name === input.repository
    && pr.head?.repo?.full_name === input.repository
    && pr.head?.ref === 'release-please--branches--main');
  if (releasePrs.length !== 1) throw new Error('Expected one merged Release Please PR for the exact commit');
  /** @param {string} revision @param {string} file */
  const read = (revision, file) => json('git', ['show', `${revision}:${file}`]);
  const current = read(input.sha, '.release-please-manifest.json');
  const previous = read(`${input.sha}^`, '.release-please-manifest.json');
  const config = read(input.sha, 'release-please-config.json');
  /** @type {Record<string, string>} */
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
  run('gh', ['issue', 'edit', String(releasePrs[0]?.number), '--repo', input.repository,
    '--add-label', 'autorelease: tagged', '--remove-label', 'autorelease: pending']);
  return { ...outputs, releases_created: 'true', paths_released: JSON.stringify(paths) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputs = resolveReleaseOutputs({
    outcome: process.env['RELEASE_ACTION_OUTCOME'] ?? '',
    outputs: JSON.parse(process.env['RELEASE_ACTION_OUTPUTS'] ?? '{}'),
    repository: process.env['GITHUB_REPOSITORY'] ?? '',
    event: process.env['GITHUB_EVENT_NAME'] ?? '',
    ref: process.env['GITHUB_REF'] ?? '',
    sha: process.env['GITHUB_SHA'] ?? '',
  });
  for (const [key, value] of Object.entries(outputs)) {
    const delimiter = `output_${crypto.randomUUID()}`;
    appendFileSync(process.env['GITHUB_OUTPUT'] ?? '', `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}
