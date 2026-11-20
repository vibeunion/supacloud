import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  checkPublishPlan,
  readJobOutputs,
  readJobScalar,
  readJobSteps,
} from './release-publish-plan.mjs';

const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
const plan = JSON.parse(readFileSync(new URL('../release/publish-plan.json', import.meta.url), 'utf8'));

/** @param {string} directory */
const readPackageJson = (directory) =>
  JSON.parse(readFileSync(new URL(`../../${directory}/package.json`, import.meta.url), 'utf8'));

const check = (source, candidate = plan) =>
  checkPublishPlan({ source, plan: candidate, readPackageJson });

const QUERY_STEP = "      - name: Publish Query adapter to NPM\n";

/** @param {string} fragment */
function withQueryStep(fragment) {
  assert.ok(workflow.includes(QUERY_STEP), 'the Query publish step moved; update this guard');
  return workflow.replace(QUERY_STEP, `${QUERY_STEP}${fragment}`);
}

test('reads publish steps into objects instead of slicing YAML text', () => {
  const source = `  publish-npm:
    needs: release-please
    steps:
      - name: "Publish demo to NPM"
        id: publish_demo
        if: \${{ always() && needs.release-please.outputs.demo_released == 'true' }}
        working-directory: packages/demo
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_BOOTSTRAP_TOKEN }}
        run: |
          bun run build
          node publish.mjs
      - name: Publish release notes
        run: echo done
`;

  const steps = readJobSteps(source, 'publish-npm');

  assert.equal(steps.length, 2);
  assert.deepEqual(
    { name: steps[0].name, id: steps[0].id, dir: steps[0]['working-directory'] },
    { name: 'Publish demo to NPM', id: 'publish_demo', dir: 'packages/demo' },
  );
  assert.deepEqual(steps[0].env, { NODE_AUTH_TOKEN: '${{ secrets.NPM_BOOTSTRAP_TOKEN }}' });
  assert.equal(steps[0].run, 'bun run build\nnode publish.mjs');
  assert.equal(steps[1].name, 'Publish release notes');
});

test('reads the release job output map', () => {
  const outputs = readJobOutputs(workflow, 'release-please');
  assert.match(outputs.query_released, /packages\/query--release_created/);
});

test('refuses YAML outside the supported subset instead of guessing', () => {
  const base = `  publish-npm:
    steps:
      - name: Publish demo
        run: |
          echo hi
`;
  assert.throws(
    () => readJobSteps(base.replace('run: |', 'run: >'), 'publish-npm'),
    /folded block scalar/,
  );
  assert.throws(
    () => readJobSteps(base.replace('name: Publish demo', 'name: &steps Publish demo'), 'publish-npm'),
    /anchor/,
  );
  assert.throws(
    () => readJobSteps(base.replace('name: Publish demo', 'name: Publish demo\n        env: [A]'), 'publish-npm'),
    /flow collection/,
  );
});

test('the workflow matches the declared publish plan', () => {
  assert.deepEqual(check(workflow), []);
});

test('every planned gate is a release-please output', () => {
  const outputs = readJobOutputs(workflow, 'release-please');
  for (const step of plan.steps) {
    assert.ok(step.gate in outputs, `${step.name}: ${step.gate} is not a release-please output`);
  }
});

test('the plan keeps the consumer order: contracts, compiler, elysia, then cli and admin', () => {
  const position = (name) => plan.steps.findIndex((step) => step.name === name);
  const delivery = position('Publish delivery contracts to NPM');
  const compiler = position('Publish app compiler to NPM');
  const elysia = position('Publish elysia adapter to NPM');
  const cli = position('Publish cli to NPM');
  const admin = position('Publish admin to NPM');

  assert.ok(delivery < compiler && compiler < cli, 'delivery and compiler publish before the CLI');
  assert.ok(elysia < cli, 'the CLI consumes the published Elysia adapter');
  assert.ok(cli < admin, 'the admin CLI consumes the published CLI');

  const cliStep = plan.steps[cli];
  assert.deepEqual(cliStep.requires, ['publish_delivery', 'publish_compiler', 'publish_elysia']);
});

test('a publish step that drops its release gate is reported', () => {
  const source = workflow.replace(
    "needs.release-please.outputs.query_released == 'true'",
    "needs.release-please.outputs.releases_created == 'true'",
  );
  const problems = check(source);
  assert.ok(problems.some((problem) => /Publish Query adapter to NPM: if: does not gate on .*query_released/.test(problem)), problems.join('\n'));
});

test('a token on an OIDC publish step is reported', () => {
  const problems = check(withQueryStep('        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}\n'));
  assert.ok(problems.some((problem) => /Publish Query adapter to NPM: OIDC publication must not pass NODE_AUTH_TOKEN/.test(problem)), problems.join('\n'));
});

test('continue-on-error on a publish step is reported', () => {
  const problems = check(withQueryStep('        continue-on-error: true\n'));
  assert.ok(problems.some((problem) => /continue-on-error must not hide/.test(problem)), problems.join('\n'));
});

test('a bootstrap step that silently drops provenance is reported', () => {
  const candidate = structuredClone(plan);
  candidate.steps.find((step) => step.name === 'Publish model tooling to NPM').provenance = false;
  const problems = check(workflow, candidate);
  assert.ok(
    problems.some((problem) => /Publish model tooling to NPM: SUPACLOUD_NPM_PUBLISH_IGNORE_PROVENANCE/.test(problem)),
    problems.join('\n'),
  );
});

test('an undeclared dependency and an unknown gate are reported', () => {
  const candidate = structuredClone(plan);
  candidate.steps.find((step) => step.name === 'Publish Query adapter to NPM').requires = ['publish_missing'];
  candidate.steps.find((step) => step.name === 'Publish supacloud-js to NPM').gate = 'supacloud_js_released_typo';
  const problems = check(workflow, candidate);
  assert.ok(problems.some((problem) => /requires publish_missing, which is not an earlier publish step/.test(problem)), problems.join('\n'));
  assert.ok(problems.some((problem) => /supacloud_js_released_typo is not a release-please output/.test(problem)), problems.join('\n'));
});

test('a plan that contradicts the workflow order is reported', () => {
  const candidate = structuredClone(plan);
  const cli = candidate.steps.findIndex((step) => step.name === 'Publish cli to NPM');
  const elysia = candidate.steps.findIndex((step) => step.name === 'Publish elysia adapter to NPM');
  [candidate.steps[cli], candidate.steps[elysia]] = [candidate.steps[elysia], candidate.steps[cli]];
  const problems = check(workflow, candidate);
  assert.ok(problems.some((problem) => /expected at position \d+, found/.test(problem)), problems.join('\n'));
});

test('Query recovery stays opt-in, main-only and skips release creation', () => {
  const jobIf = readJobScalar(workflow, 'publish-npm', 'if');
  assert.match(jobIf, /\(inputs\.recover_query == true && github\.ref == 'refs\/heads\/main'\)/);

  const query = readJobSteps(workflow, 'publish-npm')
    .find((step) => step.name === 'Publish Query adapter to NPM');
  assert.match(query.if, /\(inputs\.recover_query == true && github\.ref == 'refs\/heads\/main'\)/);
  assert.ok(query.if.startsWith('${{ !cancelled()'), 'a recovery run must not skip the Query step');

  assert.match(
    workflow,
    /recover_query:\n\s+description: Retry only the Query adapter publication\n\s+required: false\n\s+default: false\n\s+type: boolean/,
  );
  const releaseAction = workflow.match(/- uses: googleapis\/release-please-action@[^\n]+\n\s+if: ([^\n]+)/);
  assert.ok(releaseAction, 'Missing the Release Please action');
  assert.match(releaseAction[1], /inputs\.recover_query != true/);
});