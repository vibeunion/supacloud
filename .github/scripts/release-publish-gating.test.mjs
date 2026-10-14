import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');

// The npm publication job is a single sequential job. Every package that owns
// its own release component must gate its publish step on that component's
// `releases_created` output, otherwise the step runs on unrelated releases. A
// missing gate made the never-bootstrapped @supacloud/query publish step run on
// every release and fail the whole workflow.
const ROOT_PREREQUISITES = new Set([
  // Republished idempotently on every release; the rest of the graph depends on
  // the published contracts, so they intentionally follow the aggregate flag.
  'Publish command contracts to NPM',
  'Publish delivery contracts to NPM',
]);

const QUERY_OUTPUT = 'query_released';
const QUERY_OUTPUT_EXPRESSION = "${{ steps.release.outputs['packages/query--release_created'] }}";

const outputsMatch = source.match(/^ {4}outputs:\n((?: {6}[a-zA-Z0-9_]+:.*\n)+)/m);
assert.ok(outputsMatch, 'Expected the release-please job outputs block');

const outputs = new Map(
  [...outputsMatch[1].matchAll(/^ {6}([a-zA-Z0-9_]+): (.*)$/gm)].map(match => [match[1], match[2]]),
);

const publishSteps = [...source.matchAll(/^ {6}- name: (Publish .*? to NPM)\n(?: {8}.*\n)*? {8}if: (.*)$/gm)]
  .map(match => ({ name: match[1], condition: match[2] }));

test('the release-please job exposes a query_released output', () => {
  assert.equal(outputs.get(QUERY_OUTPUT), QUERY_OUTPUT_EXPRESSION);
});

test('every package publish step is gated on its own release component', () => {
  assert.ok(publishSteps.length > 0, 'Expected at least one npm publish step');
  for (const { name, condition } of publishSteps) {
    if (ROOT_PREREQUISITES.has(name)) continue;
    assert.match(
      condition,
      /needs\.release-please\.outputs\.[a-z0-9_]+_released == 'true'/,
      `${name} must gate on a per-package *_released output, not the aggregate releases_created flag`,
    );
  }
});

test('the query publish step is gated on query_released', () => {
  const query = publishSteps.find(step => step.name === 'Publish Query adapter to NPM');
  assert.ok(query, 'Missing the Query adapter publish step');
  assert.match(query.condition, /needs\.release-please\.outputs\.query_released == 'true'/);
  assert.doesNotMatch(query.condition, /outputs\.releases_created/);
});

function queryPublishStep(workflow) {
  const start = workflow.indexOf('- name: Publish Query adapter to NPM');
  assert.ok(start >= 0, 'Missing the Query adapter publish step');
  const end = workflow.indexOf('\n      - name:', start + 1);
  assert.ok(end > start, 'Missing the step after the Query adapter');
  return workflow.slice(start, end);
}

function assertQueryOidcOnly(workflow) {
  const block = queryPublishStep(workflow);
  assert.doesNotMatch(block, /NODE_AUTH_TOKEN|NPM_TOKEN|NPM_BOOTSTRAP_TOKEN/);
  assert.doesNotMatch(block, /continue-on-error/);
}

test('the complete query publish step authenticates through npm OIDC, not a token', () => {
  assertQueryOidcOnly(source);
});

test('the OIDC guard catches authentication changes after working-directory', () => {
  const withToken = source.replace(
    'working-directory: packages/query\n',
    'working-directory: packages/query\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}\n',
  );
  assert.throws(() => assertQueryOidcOnly(withToken), assert.AssertionError);
  const withIgnoredFailure = source.replace(
    'working-directory: packages/query\n',
    'working-directory: packages/query\n        continue-on-error: true\n',
  );
  assert.throws(() => assertQueryOidcOnly(withIgnoredFailure), assert.AssertionError);
});

test('Query recovery is opt-in, main-only, and skips release creation', () => {
  assert.match(source, /recover_query:\n\s+description: Retry only the Query adapter publication\n\s+required: false\n\s+default: false\n\s+type: boolean/);
  const releaseAction = source.match(/- uses: googleapis\/release-please-action@[^\n]+\n\s+if: ([^\n]+)/);
  assert.ok(releaseAction, 'Missing Release Please action');
  assert.match(releaseAction[1], /inputs\.recover_query != true/);
  const publishJob = source.match(/\n  publish-npm:\n\s+needs: release-please\n(?:\s+#[^\n]*\n)*\s+if: ([^\n]+)/);
  assert.ok(publishJob, 'Missing npm publish job gate');
  const mainOnlyRecovery = /\(inputs\.recover_query == true && github\.ref == 'refs\/heads\/main'\)/;
  assert.match(publishJob[1], mainOnlyRecovery);
  assert.match(queryPublishStep(source), mainOnlyRecovery);
});

test('only Query consumes its recovery input and retains the shared publisher', () => {
  for (const { name, condition } of publishSteps) {
    if (name !== 'Publish Query adapter to NPM') {
      assert.doesNotMatch(condition, /inputs\.recover_query/, name);
    }
  }
  assert.match(queryPublishStep(source), /node "\$GITHUB_WORKSPACE\/\.github\/scripts\/publish-npm-package\.mjs"/);
  const job = source.split('\n  publish-npm:\n')[1]?.split('\n  sync-')[0];
  assert.ok(job);
  assert.match(job, /environment: npm-publish/);
  assert.match(job, /id-token: write/);
  assert.match(job, /registry-url: 'https:\/\/registry\.npmjs\.org'/);
});

test('every referenced *_released output is declared in the job outputs', () => {
  for (const { name, condition } of publishSteps) {
    for (const match of condition.matchAll(/needs\.release-please\.outputs\.([a-z0-9_]+)/g)) {
      assert.ok(
        outputs.has(match[1]),
        `${name} references undeclared output ${match[1]}`,
      );
    }
  }
});
