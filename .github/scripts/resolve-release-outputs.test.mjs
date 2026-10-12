import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveReleaseOutputs } from './resolve-release-outputs.mjs';

const sha = 'a'.repeat(40);
const repository = 'vibeunion/supacloud';
const input = { outcome: 'failure', outputs: {}, repository, event: 'push', ref: 'refs/heads/main', sha };

function fixture() {
  const components = ['management-api', 'edge-runtime', 'supacloud-lite', 'cli'];
  const current = Object.fromEntries(components.map(name => [`packages/${name}`, '0.2.0']));
  const previous = Object.fromEntries(components.map(name => [`packages/${name}`, '0.1.0']));
  const config = { packages: Object.fromEntries(components.map(name => [`packages/${name}`, { component: name }])) };
  const prs = [{
    number: 1857, merged_at: '2026-10-12T12:22:21Z', merge_commit_sha: sha,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { ref: 'release-please--branches--main', repo: { full_name: repository } },
  }];
  const releases = Object.fromEntries(components.map(name => [`${name}-v0.2.0`, {
    tag_name: `${name}-v0.2.0`, target_commitish: sha, draft: false, prerelease: false,
    published_at: '2026-10-12T12:22:45Z', assets: [],
  }]));
  const writes = [];
  let tagCommit = sha;
  let packageVersion = '0.2.0';
  const run = (command, args) => {
    if (command === 'gh' && args[0] === 'issue') {
      writes.push(args);
      return '';
    }
    if (command === 'gh' && args[1].endsWith('/pulls')) return JSON.stringify(prs);
    if (command === 'gh') {
      const release = releases[args[1].split('/').at(-1)];
      if (!release) throw new Error('404 release missing');
      return JSON.stringify(release);
    }
    if (args[0] === 'rev-parse') return tagCommit;
    if (args[1] === `${sha}:.release-please-manifest.json`) return JSON.stringify(current);
    if (args[1] === `${sha}^:.release-please-manifest.json`) return JSON.stringify(previous);
    if (args[1] === `${sha}:release-please-config.json`) return JSON.stringify(config);
    if (args[1].endsWith('/package.json')) return JSON.stringify({ version: packageVersion });
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { run, current, previous, prs, releases, writes,
    setTagCommit(value) { tagCommit = value; }, setPackageVersion(value) { packageVersion = value; } };
}

test('successful action outputs are passed through without recovery writes', () => {
  const outputs = { releases_created: 'true', 'packages/cli--tag_name': 'cli-v0.2.0', prs: '[\n]' };
  assert.deepEqual(resolveReleaseOutputs({ ...input, outcome: 'success', outputs }, () => {
    throw new Error('Recovery must not run');
  }), outputs);
});

test('restores all four outputs only after validating every release and repairs labels once', () => {
  const f = fixture();
  const outputs = resolveReleaseOutputs(input, f.run);
  assert.equal(outputs.releases_created, 'true');
  assert.equal(JSON.parse(outputs.paths_released).length, 4);
  for (const component of ['management-api', 'edge-runtime', 'supacloud-lite', 'cli']) {
    assert.equal(outputs[`packages/${component}--release_created`], 'true');
    assert.equal(outputs[`packages/${component}--tag_name`], `${component}-v0.2.0`);
  }
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], ['issue', 'edit', '1857', '--repo', repository,
    '--add-label', 'autorelease: tagged', '--remove-label', 'autorelease: pending']);
});

for (const override of [
  { outcome: 'skipped' }, { repository: 'someone/fork' }, { event: 'workflow_dispatch' },
  { ref: 'refs/heads/feature' }, { sha: 'main' },
]) {
  test(`rejects ineligible recovery ${JSON.stringify(override)}`, () => {
    assert.throws(() => resolveReleaseOutputs({ ...input, ...override }, () => {
      throw new Error('Must reject before reads');
    }), /outside an eligible release push/);
  });
}

for (const fault of ['missing', 'draft', 'prerelease', 'assets', 'target', 'tag', 'unpublished',
  'packageVersion', 'tagCommit', 'foreignPr', 'unmergedPr', 'wrongMerge', 'duplicatePr', 'noChange', 'version']) {
  test(`fails closed without label writes for ${fault}`, () => {
    const f = fixture();
    const release = f.releases['cli-v0.2.0'];
    if (fault === 'missing') delete f.releases['cli-v0.2.0'];
    if (fault === 'draft') release.draft = true;
    if (fault === 'prerelease') release.prerelease = true;
    if (fault === 'assets') release.assets.push({ name: 'partial-binary' });
    if (fault === 'target') release.target_commitish = 'main';
    if (fault === 'tag') release.tag_name = 'cli-v9.0.0';
    if (fault === 'unpublished') release.published_at = null;
    if (fault === 'packageVersion') f.setPackageVersion('0.1.0');
    if (fault === 'tagCommit') f.setTagCommit('b'.repeat(40));
    if (fault === 'foreignPr') f.prs[0].head.repo.full_name = 'someone/fork';
    if (fault === 'unmergedPr') f.prs[0].merged_at = null;
    if (fault === 'wrongMerge') f.prs[0].merge_commit_sha = 'b'.repeat(40);
    if (fault === 'duplicatePr') f.prs.push(f.prs[0]);
    if (fault === 'noChange') Object.assign(f.previous, f.current);
    if (fault === 'version') f.current['packages/cli'] = '0.2.0\ninjected';
    assert.throws(() => resolveReleaseOutputs(input, f.run));
    assert.equal(f.writes.length, 0);
  });
}

test('workflow routes original outputs through the fail-closed resolver', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id: release-action\n\s+continue-on-error: true/);
  assert.match(workflow, /id: release\n\s+env:/);
  assert.match(workflow, /RELEASE_ACTION_OUTCOME: \$\{\{ steps\.release-action\.outcome \}\}/);
  assert.match(workflow, /git fetch origin --tags/);
  assert.match(workflow, /node .github\/scripts\/resolve-release-outputs.mjs/);
});
