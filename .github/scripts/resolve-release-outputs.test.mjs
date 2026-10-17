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

function successfulOutputs(f) {
  const paths = Object.keys(f.current);
  return { releases_created: 'true', paths_released: JSON.stringify(paths), prs: '[\n]',
    ...Object.fromEntries(paths.flatMap(path => [
      [`${path}--release_created`, 'true'],
      [`${path}--tag_name`, `${path.split('/').at(-1)}-v${f.current[path]}`],
      [`${path}--version`, f.current[path]],
      [`${path}--sha`, sha],
    ])) };
}

test('coherent successful action outputs pass without recovery writes', () => {
  const f = fixture();
  const outputs = successfulOutputs(f);
  assert.deepEqual(resolveReleaseOutputs({ ...input, outcome: 'success', outputs }, f.run), outputs);
  assert.equal(f.writes.length, 0);
});

for (const fault of ['tag', 'package', 'version', 'inventory', 'unknown', 'falseSummary', 'source', 'missingSource']) {
  test(`successful action fails closed for ${fault}`, () => {
    const f = fixture();
    const outputs = successfulOutputs(f);
    if (fault === 'source') outputs['packages/cli--sha'] = 'b'.repeat(40);
    if (fault === 'missingSource') delete outputs['packages/cli--sha'];
    if (fault === 'tag') outputs['packages/cli--tag_name'] = 'cli-v0.3.0';
    if (fault === 'package') f.setPackageVersion('0.3.0');
    if (fault === 'version') outputs['packages/cli--version'] = '0.3.0';
    if (fault === 'inventory') outputs.paths_released = '[]';
    if (fault === 'unknown') {
      outputs['packages/unknown--release_created'] = 'true';
      outputs.paths_released = JSON.stringify([...Object.keys(f.current), 'packages/unknown']);
    }
    if (fault === 'falseSummary') outputs.releases_created = 'false';
    assert.throws(() => resolveReleaseOutputs({ ...input, outcome: 'success', outputs }, f.run));
    assert.equal(f.writes.length, 0);
  });
}

for (const component of ['app', 'app-svelte', 'compiler']) {
  test(`rejects omitted changed ${component} even when output inventory is self-consistent`, () => {
    const f = fixture();
    const outputs = successfulOutputs(f);
    f.current[`packages/${component}`] = '0.2.0';
    f.previous[`packages/${component}`] = '0.1.0';
    assert.throws(() => resolveReleaseOutputs({ ...input, outcome: 'success', outputs }, f.run),
      new RegExp(`Missing changed release output: packages/${component}`));
    assert.equal(f.writes.length, 0);
  });
}

test('ordinary no-release push and explicit npm retry with no new release remain valid', () => {
  const f = fixture();
  const outputs = { releases_created: 'false', paths_released: '[]' };
  assert.deepEqual(resolveReleaseOutputs({ ...input, event: 'workflow_dispatch', outcome: 'success', outputs }, f.run), outputs);
  assert.throws(() => resolveReleaseOutputs({ ...input, outcome: 'success', outputs }, f.run), /Missing changed release/);
  Object.assign(f.previous, f.current);
  assert.deepEqual(resolveReleaseOutputs({ ...input, outcome: 'success', outputs }, f.run), outputs);
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

test('npm publication cannot bypass a failed identity guard, including explicit retries', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  const npm = workflow.slice(workflow.indexOf('  publish-npm:'), workflow.indexOf('  sync-supacloud-dependencies:'));
  assert.match(npm, /if: \$\{\{ always\(\) && needs\.release-please\.result == 'success'/);
  for (const recovery of ['recover_npm', 'recover_elysia', 'recover_query']) {
    assert.ok(npm.includes(`inputs.${recovery} == true`));
  }
});

test('delayed releases cannot hide omitted components behind an unchanged event manifest', () => {
  const f = fixture();
  Object.assign(f.previous, f.current);
  const outputs = successfulOutputs(f);
  for (const path of Object.keys(f.current)) outputs[`${path}--sha`] = 'b'.repeat(40);
  assert.throws(() => resolveReleaseOutputs({ ...input, outcome: 'success', outputs }, f.run),
    /Release output source mismatch/);
  assert.equal(f.writes.length, 0);
});
