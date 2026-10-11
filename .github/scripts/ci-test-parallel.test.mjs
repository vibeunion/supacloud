import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../workflows/management-api.yml', import.meta.url));
const parsed = spawnSync('bun', ['--no-env-file', '-e',
  'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))',
  workflowPath,
], { encoding: 'utf8', timeout: 5000 });
assert.equal(parsed.status, 0, parsed.stderr);
const workflow = JSON.parse(parsed.stdout);
const job = workflow.jobs['package-checks'];
const candidates = job.strategy.matrix.include.filter(entry =>
  ['Project CLI', 'App Compiler'].includes(entry.name));

test('CLI and Compiler use three isolated workers without reducing test coverage', () => {
  assert.equal(candidates.length, 2);
  assert.equal(job.strategy['fail-fast'], false);
  for (const entry of candidates) {
    const pattern = entry.name === 'Project CLI' ? ' src' : '';
    const timeout = ' --timeout=10000';
    assert.equal(entry.test_script.trim(),
      `bun test${pattern} --parallel=3${timeout} --isolate --timings "$RUNNER_TEMP/${entry.test_timings}" --update-timings`);
    assert.match(entry.typecheck_script, /bun run typecheck/);
    assert.match(entry.build_script, /bun run build/);
    assert.match(entry.acceptance_script, /audit_dependencies\.ts/);
  }
  assert.deepEqual(job.strategy.matrix.include.filter(entry => entry.test_timings).map(entry => entry.name),
    ['Project CLI', 'App Compiler']);
  const execution = job.steps.find(step => step.name === 'Test package');
  assert.equal(execution.if, "${{ matrix.test_script != '' }}");
  assert.equal(execution.run, '${{ matrix.test_script }}');
  assert.notEqual(execution['continue-on-error'], true);
  const upload = job.steps.find(step => step.name === 'Upload package test timings');
  assert.equal(upload.if, "${{ always() && matrix.test_timings != '' }}");
  assert.equal(upload.uses, 'actions/upload-artifact@v6');
  assert.equal(upload.with.path, '${{ runner.temp }}/${{ matrix.test_timings }}');
  assert.equal(upload.with.name, 'package-test-timings-${{ strategy.job-index }}');
  assert.equal(upload.with['retention-days'], 3);
  assert.ok(workflow.jobs['docker-and-scripts-checks'].steps.some(step =>
    step.run?.includes('node --test .github/scripts/ci-test-parallel.test.mjs')));
});

for (const entry of candidates) {
  test(`${entry.name} command runs overlapping files with isolated globals and emits timings`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-test-parallel-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/state.ts'), 'export const state = { dirty: false };\n');
    try {
      for (const [name, peer] of [['first', 'second'], ['second', 'first']]) {
        writeFileSync(join(root, `src/${name}.test.ts`), `
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { state } from "./state";
test("isolated file ${name}", async () => {
  expect(state.dirty).toBe(false);
  expect(process.env.CI_PARALLEL_SENTINEL).toBeUndefined();
  state.dirty = true;
  process.env.CI_PARALLEL_SENTINEL = "${name}";
  writeFileSync("${name}.started", String(process.pid));
  const deadline = Date.now() + 5000;
  while (!existsSync("${peer}.started") && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync("${peer}.started")).toBe(true);
});
`);
      }
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', entry.test_script], {
        cwd: root, env: { ...process.env, RUNNER_TEMP: root },
        encoding: 'utf8', timeout: 12000,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notEqual(readFileSync(join(root, 'first.started'), 'utf8'),
        readFileSync(join(root, 'second.started'), 'utf8'));
      const timings = JSON.parse(readFileSync(join(root, entry.test_timings), 'utf8'));
      assert.equal(timings.version, 1);
      assert.deepEqual(Object.keys(timings.files).sort(), ['src/first.test.ts', 'src/second.test.ts']);
      for (const duration of Object.values(timings.files)) {
        assert.ok(Number.isFinite(duration) && duration >= 0);
      }
      writeFileSync(join(root, 'src/failure.test.ts'),
        'import { expect, test } from "bun:test"; test("must fail", () => expect(1).toBe(2));\n');
      const failure = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', entry.test_script], {
        cwd: root, env: { ...process.env, RUNNER_TEMP: root },
        encoding: 'utf8', timeout: 12000,
      });
      if (failure.error) throw failure.error;
      assert.equal(failure.status, 1, failure.stdout + failure.stderr);
      const failureTimings = JSON.parse(readFileSync(join(root, entry.test_timings), 'utf8'));
      assert.ok(Object.hasOwn(failureTimings.files, 'src/failure.test.ts'),
        'A failed run must retain timings for failure investigation');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
