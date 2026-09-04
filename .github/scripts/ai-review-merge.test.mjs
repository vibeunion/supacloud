import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  AiApiError,
  buildMergeRequestBody,
  detectSelfModification,
  formatAiUnavailableComment,
  hasNoAiMergeLabel,
  isAiProviderUnavailableError,
  isReleasePleasePullRequest,
  isTrustedSubmitter,
  summarizeCIStatus,
  summarizeAiProviderError,
  validatePullRequestForMerge,
} from './ai-review-merge.mjs';

describe('AI review provider failure handling', () => {
  test('classifies provider auth failures hidden behind HTTP 500 as unavailable', () => {
    const error = new AiApiError(
      500,
      '{"error":{"message":"xunfei response error: AppIdNoAuthError (request id: 2026062214080095251574710887624)"}}',
    );

    assert.equal(isAiProviderUnavailableError(error), true);
    assert.match(summarizeAiProviderError(error), /HTTP 500/);
    assert.match(summarizeAiProviderError(error), /AppIdNoAuthError/);
  });

  test('classifies rate limits and network failures as unavailable', () => {
    assert.equal(isAiProviderUnavailableError(new AiApiError(429, 'rate limit exceeded')), true);
    assert.equal(isAiProviderUnavailableError(new TypeError('fetch failed: ECONNRESET')), true);
  });

  test('does not hide local script bugs as provider downtime', () => {
    assert.equal(isAiProviderUnavailableError(new Error('Cannot read properties of undefined')), false);
    assert.equal(isAiProviderUnavailableError(new AiApiError(400, 'invalid JSON request body')), false);
  });

  test('formats a neutral notice that disables auto-merge without leaking secrets', () => {
    const comment = formatAiUnavailableComment({
      model: 'qwen-review',
      sha: 'a854c3d6f2503859531be54b2b1cbdbb9d86dde3',
      error: new AiApiError(403, 'Authorization: Bearer sk-secret api_key=abc123 Forbidden'),
      ciStatus: { allCompleted: true, allPassed: true },
    });

    assert.match(comment, /^## AI Review Unavailable \(qwen-review\) — a854c3d/m);
    assert.match(comment, /关闭自动合并/);
    assert.match(comment, /当前业务 CI 已完成并通过/);
    assert.doesNotMatch(comment, /sk-secret/);
    assert.doesNotMatch(comment, /abc123/);
  });
});

describe('CI merge gate', () => {
  test('fails closed when no business checks exist', () => {
    assert.deepEqual(summarizeCIStatus({ checkRuns: [], statuses: [] }), {
      allCompleted: false,
      allPassed: false,
      results: ['- No business CI checks found (fail-closed)'],
    });
  });

  test('ignores its own review check while requiring completed business checks', () => {
    assert.deepEqual(summarizeCIStatus({
      checkRuns: [
        { name: 'AI Review & Auto-Merge', status: 'in_progress', conclusion: null },
        { name: 'Package Checks', status: 'completed', conclusion: 'success' },
        { name: 'Build Binaries', status: 'completed', conclusion: 'skipped' },
      ],
      statuses: [],
    }), {
      allCompleted: true,
      allPassed: true,
      results: ['- Package Checks: success', '- Build Binaries: skipped'],
    });
  });

  test('blocks pending or failed business checks', () => {
    const status = summarizeCIStatus({
      checkRuns: [
        { name: 'Package Checks', status: 'in_progress', conclusion: null },
        { name: 'Unit Tests', status: 'completed', conclusion: 'failure' },
      ],
      statuses: [],
    });
    assert.equal(status.allCompleted, false);
    assert.equal(status.allPassed, false);
  });
});

describe('trusted review workflow', () => {
  test('requires human review for every workflow and review-gate script change', () => {
    const modified = detectSelfModification([
      { filename: '.github/workflows/release-please.yml' },
      { filename: '.github/workflows/future-privileged-workflow.yml' },
      { filename: '.github/scripts/ai-review-merge.test.mjs' },
      { filename: 'packages/management-api/src/index.ts' },
    ]);

    assert.deepEqual(modified, [
      '.github/workflows/release-please.yml',
      '.github/workflows/future-privileged-workflow.yml',
      '.github/scripts/ai-review-merge.test.mjs',
    ]);
  });

  test('runs from workflow_run on the default branch without executing PR-head code', () => {
    const workflow = readFileSync(new URL('../workflows/ai-review-merge.yml', import.meta.url), 'utf8');
    assert.match(workflow, /workflow_run:/);
    assert.match(workflow, /workflows:\s*\["Management API CI"\]/);
    assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.doesNotMatch(workflow, /^\s{2}pull_request:/m);
    assert.doesNotMatch(workflow, /^\s{2}check_suite:/m);
    assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.sha/);
    assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress:\s*true/);
    assert.match(workflow, /STATE=\$\(jq -r '\.state(?: \/\/ empty)?'/);
    assert.match(workflow, /if \[ "\$STATE" != "open" \]/);
    assert.match(workflow, /case "\$BASE_REF" in[\s\S]*?main\|dev\)/);
    assert.match(workflow, /RUN_BASE_REF=\$\(jq -r '\.workflow_run\.pull_requests\[0\]\.base\.ref \/\/ empty'/);
    assert.match(workflow, /RUN_HEAD_REF=\$\(jq -r '\.workflow_run\.pull_requests\[0\]\.head\.ref \/\/ empty'/);
    assert.match(workflow, /if \[ "\$BASE_REF" != "\$RUN_BASE_REF" \]/);
    assert.match(workflow, /if \[ "\$PR_HEAD_REF" != "\$RUN_HEAD_REF" \]/);
    assert.doesNotMatch(workflow, /commits\/\$\{HEAD_SHA\}\/pulls/);
  });

  test('secretless CI covers every published CLI, full unit isolation, audit, and SBOM', () => {
    const workflow = readFileSync(new URL('../workflows/management-api.yml', import.meta.url), 'utf8');
    const releaseWorkflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
    const managementPackage = readFileSync(new URL('../../packages/management-api/package.json', import.meta.url), 'utf8');
    const unitRunner = readFileSync(new URL('../../packages/management-api/scripts/run-unit-tests.ts', import.meta.url), 'utf8');
    for (const packagePath of ['packages/admin/**', 'packages/cli/**', 'packages/supacloud/**', 'packages/function-adapter/**']) {
      assert.match(workflow, new RegExp(packagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(workflow, /working-directory: packages\/admin[\s\S]*?bun run typecheck[\s\S]*?bun test/);
    assert.match(workflow, /working-directory: packages\/cli[\s\S]*?bun run typecheck[\s\S]*?bun test/);
    assert.match(workflow, /working-directory: packages\/supacloud[\s\S]*?bun run typecheck[\s\S]*?bun test[\s\S]*?bun run build/);
    assert.match(workflow, /working-directory: packages\/management-api[\s\S]*?run: bun run test:unit/);
    assert.match(managementPackage, /"test:unit": "bun run scripts\/run-unit-tests\.ts"/);
    assert.match(unitRunner, /mock\\\.module/);
    assert.match(unitRunner, /await runTestBatch\(sharedFiles/);
    assert.match(unitRunner, /await runTestBatch\(\[file\]/);
    assert.match(unitRunner, /await runTestBatch\(\[apiTest\]/);
    assert.match(workflow, /audit_dependencies\.ts/);
    assert.match(readFileSync(new URL('../../scripts/audit_dependencies.ts', import.meta.url), 'utf8'), /\["audit", "--audit-level", "high"\]/);
    assert.match(workflow, /anchore\/sbom-action@/);
    assert.match(workflow, /XCADDY_VERSION:\s*["']v0\.4\.5["']/);
    assert.match(workflow, /xcaddy\/cmd\/xcaddy@\$\{XCADDY_VERSION\}/);
    assert.doesNotMatch(workflow, /xcaddy\/cmd\/xcaddy@latest/);
    for (const contents of [workflow, releaseWorkflow]) {
      const installLines = contents.split(/\r?\n/).filter((candidate) => candidate.includes('bun install'));
      const lockfileGenerationLines = installLines.filter((line) => line.includes('--lockfile-only'));
      for (const line of installLines.filter((candidate) => !candidate.includes('--lockfile-only'))) {
        assert.match(line, /bun install --frozen-lockfile/);
      }
      if (contents === releaseWorkflow) {
        assert.deepEqual(lockfileGenerationLines, [
          '          bun install --lockfile-only --registry https://registry.npmjs.org',
        ]);
      } else {
        assert.deepEqual(lockfileGenerationLines, []);
      }
    }
    assert.doesNotMatch(releaseWorkflow, /bunx\s+npm\s+publish/);
    assert.match(releaseWorkflow, /npm --version/);
    assert.equal(
      releaseWorkflow.match(/node "\$GITHUB_WORKSPACE\/\.github\/scripts\/publish-npm-package\.mjs"/g)?.length,
      11,
      'all npm packages must use the retry-safe publisher',
    );
    assert.doesNotMatch(releaseWorkflow, /^\s+npm publish/m);
    for (const packageName of ['management-api', 'web-console', 'supacloud-js', 'edge-runtime', 'admin', 'cli', 'supacloud', 'function-adapter']) {
      assert.equal(
        existsSync(new URL(`../../packages/${packageName}/bun.lock`, import.meta.url)),
        true,
        `${packageName} must commit a reproducible Bun lockfile`,
      );
    }
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.doesNotMatch(workflow, /^\s+contents: write$/m);
  });
});

describe('atomic merge preconditions', () => {
  const openPullRequest = {
    state: 'open',
    draft: false,
    title: 'fix(release): preserve conventional commit titles',
    head: { sha: 'head-sha', ref: 'feature/harden-merge' },
    base: { ref: 'main' },
  };

  test('accepts only the current open head targeting an allowed base', () => {
    assert.deepEqual(validatePullRequestForMerge(openPullRequest, {
      expectedHeadSha: 'head-sha',
      expectedHeadRef: 'feature/harden-merge',
      expectedBaseRef: 'main',
    }), {
      headSha: 'head-sha',
      headRef: 'feature/harden-merge',
      baseRef: 'main',
      title: 'fix(release): preserve conventional commit titles',
    });

    assert.throws(
      () => validatePullRequestForMerge({ ...openPullRequest, state: 'closed' }, {
        expectedHeadSha: 'head-sha', expectedHeadRef: 'feature/harden-merge', expectedBaseRef: 'main',
      }),
      /not open/,
    );
    assert.throws(
      () => validatePullRequestForMerge(openPullRequest, {
        expectedHeadSha: 'stale-sha', expectedHeadRef: 'feature/harden-merge', expectedBaseRef: 'main',
      }),
      /head SHA changed/,
    );
    assert.throws(
      () => validatePullRequestForMerge({ ...openPullRequest, base: { ref: 'release' } }, {
        expectedHeadSha: 'head-sha', expectedHeadRef: 'feature/harden-merge', expectedBaseRef: 'main',
      }),
      /base branch/,
    );
    assert.throws(
      () => validatePullRequestForMerge(openPullRequest, {
        expectedHeadSha: 'head-sha', expectedHeadRef: 'feature/harden-merge', expectedBaseRef: 'dev',
      }),
      /base ref changed/,
    );
    assert.throws(
      () => validatePullRequestForMerge({
        ...openPullRequest,
        head: { sha: 'head-sha', ref: 'feature/replaced' },
      }, {
        expectedHeadSha: 'head-sha', expectedHeadRef: 'feature/harden-merge', expectedBaseRef: 'main',
      }),
      /head ref changed/,
    );
    assert.throws(
      () => validatePullRequestForMerge({ ...openPullRequest, title: 'fix: valid\nInjected-Header: true' }, {
        expectedHeadSha: 'head-sha', expectedHeadRef: 'feature/harden-merge', expectedBaseRef: 'main',
      }),
      /single line/,
    );
    assert.throws(
      () => validatePullRequestForMerge({
        ...openPullRequest,
        head: { sha: 'head-sha', ref: 'release-please--branches--main' },
      }, {
        expectedHeadSha: 'head-sha',
        expectedHeadRef: 'release-please--branches--main',
        expectedBaseRef: 'main',
      }),
      /human merge approval/,
    );
    assert.throws(
      () => validatePullRequestForMerge({
        ...openPullRequest,
        labels: [{ name: 'autorelease: pending' }],
      }, {
        expectedHeadSha: 'head-sha', expectedHeadRef: 'feature/harden-merge', expectedBaseRef: 'main',
      }),
      /human merge approval/,
    );
    assert.throws(
      () => validatePullRequestForMerge({
        ...openPullRequest,
        labels: [{ name: 'no-ai-merge' }],
      }, {
        expectedHeadSha: 'head-sha', expectedHeadRef: 'feature/harden-merge', expectedBaseRef: 'main',
      }),
      /no-ai-merge label/,
    );
  });

  test('preserves the conventional PR title and expected SHA for squash commits', () => {
    assert.deepEqual(buildMergeRequestBody({
      prTitle: 'fix(console): ship svadmin upgrades',
      expectedHeadSha: 'head-sha',
    }), {
      commit_title: 'fix(console): ship svadmin upgrades',
      merge_method: 'squash',
      sha: 'head-sha',
    });
  });
});

describe('Release Please merge gate', () => {
  test('detects release branches and labels independently', () => {
    assert.equal(isReleasePleasePullRequest({
      head: { ref: 'release-please--branches--main' },
      labels: [],
    }), true);
    assert.equal(isReleasePleasePullRequest({
      head: { ref: 'automation/prepare-release' },
      labels: [{ name: 'autorelease: pending' }],
    }), true);
  });

  test('keeps ordinary automation PRs eligible for the existing identity gate', () => {
    assert.equal(isReleasePleasePullRequest({
      head: { ref: 'automation/sync-supacloud-dependencies' },
      labels: [{ name: 'dependencies' }],
    }), false);
  });

  test('recognizes the manual merge freeze label at the final write boundary', () => {
    assert.equal(hasNoAiMergeLabel({ labels: ['no-ai-merge'] }), true);
    assert.equal(hasNoAiMergeLabel({ labels: [{ name: 'dependencies' }] }), false);
  });
});

describe('trusted submitter gate', () => {
  test('accepts only explicitly allowlisted bots', () => {
    assert.equal(isTrustedSubmitter({
      author_association: 'NONE',
      user: { login: 'dependabot[bot]', type: 'Bot' },
    }).trusted, true);

    const thirdParty = isTrustedSubmitter({
      author_association: 'MEMBER',
      user: { login: 'untrusted-release-bot[bot]', type: 'Bot' },
    });
    assert.equal(thirdParty.trusted, false);
    assert.match(thirdParty.reason, /untrusted-release-bot/);
  });
});
