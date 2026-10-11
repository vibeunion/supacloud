import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/esm-packages.yml', import.meta.url), 'utf8');
const build = workflow.split('\n  esm-build:\n')[1]?.split('\n  esm-consumers:\n')[0];
const consumers = workflow.split('\n  esm-consumers:\n')[1];
assert.ok(build);
assert.ok(consumers);
const candidates = ['contracts', 'delivery', 'app', 'query', 'supacloud-js', 'compiler'];
const archive = build.match(/tar -czf "\$RUNNER_TEMP\/esm-candidate-build.tar.gz" \\\n((?: {12}packages\/[^\n]+\n)+)/);
assert.ok(archive, 'Candidate archive must have an explicit path allowlist');
const paths = archive[1].trim().split('\n').map(line => line.trim().replace(/ \\$/, ''));

test('all runtime consumers use one upstream build without rebuilding candidates', () => {
  assert.equal(workflow.match(/- '.github\/scripts\/esm-build-reuse.test.mjs'/g)?.length, 2);
  assert.match(workflow, /node --test .github\/scripts\/esm-build-reuse.test.mjs/);
  assert.match(build, /needs: esm-policy/);
  assert.match(build, /for package in contracts delivery app query supacloud-js compiler/);
  assert.match(build, /bun install --frozen-lockfile && bun run build/);
  assert.doesNotMatch(build, /matrix:|continue-on-error/);
  assert.match(consumers, /needs: \[esm-policy, esm-build\]/);
  assert.match(consumers, /node: \['22\.12\.0', '24\.x', '26\.x'\]/);
  assert.match(consumers, /actions\/download-artifact@v6/);
  assert.doesNotMatch(consumers, /bun run build|bun install|continue-on-error/);
  assert.match(consumers, /esm-package\.acceptance\.mjs --sdk-only/);
  assert.match(consumers, /else\n {12}node .github\/scripts\/esm-package\.acceptance\.mjs/);
});

test('archive contains every dist, native compiler, launcher and Node type dependency', () => {
  const expected = [
    ...candidates.map(name => `packages/${name}/dist`),
    ...['app', 'supacloud-js'].flatMap(name => [
      `packages/${name}/node_modules/.bin/tsc`,
      `packages/${name}/node_modules/@types/node`,
      `packages/${name}/node_modules/typescript`,
      `packages/${name}/node_modules/@typescript/typescript-linux-x64`,
    ]),
  ];
  assert.deepEqual(paths, expected);
  assert.match(build, /runs-on: ubuntu-24.04/);
  assert.match(consumers, /runs-on: ubuntu-24.04/);
  assert.match(build, /if-no-files-found: error/);
  assert.match(build, /compression-level: 0/);
  assert.match(consumers, /cp "\$RUNNER_TEMP\/esm-candidate-build\/esm-candidate-build.tar.gz" "\$evidence\/candidate-build.tar.gz"/);
  assert.match(consumers, /dependencies.tar/);
  for (const name of ['contracts', 'delivery', 'query', 'compiler']) {
    assert.ok(!consumers.includes(`packages/${name}/node_modules`), 'Evidence must not require uninstalled dependencies');
  }
});

test('actual archive roundtrip preserves package paths, compiler links and executable bits', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'esm-build-reuse-'));
  const source = join(fixture, 'source');
  const destination = join(fixture, 'destination');
  const temporary = join(fixture, 'runner');
  mkdirSync(source);
  mkdirSync(destination);
  mkdirSync(temporary);
  const command = (script, cwd, extra = {}) => {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd, env: { ...process.env, RUNNER_TEMP: temporary, GITHUB_WORKSPACE: destination, ...extra },
      encoding: 'utf8', timeout: 5000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    for (const path of paths) {
      if (path.endsWith('/.bin/tsc')) {
        mkdirSync(dirname(join(source, path)), { recursive: true });
        symlinkSync('../typescript/bin/tsc', join(source, path));
      } else {
        mkdirSync(join(source, path), { recursive: true });
        writeFileSync(join(source, path, 'fixture.txt'), path);
      }
    }
    for (const name of ['app', 'supacloud-js']) {
      const executable = join(source, `packages/${name}/node_modules/typescript/bin/tsc`);
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, '#!/bin/sh\nprintf "restored compiler"\n');
      chmodSync(executable, 0o755);
    }
    command(archive[0], source);
    const download = join(temporary, 'esm-candidate-build');
    mkdirSync(download);
    command('cp "$RUNNER_TEMP/esm-candidate-build.tar.gz" "$RUNNER_TEMP/esm-candidate-build/"', source);
    const restore = consumers.match(/run: (tar -xzf [^\n]+)/)?.[1];
    assert.ok(restore);
    command(restore, destination);
    for (const name of candidates) {
      const path = `packages/${name}/dist`;
      assert.equal(readFileSync(join(destination, path, 'fixture.txt'), 'utf8'), path);
    }
    for (const name of ['app', 'supacloud-js']) {
      command(`test "$(packages/${name}/node_modules/.bin/tsc)" = "restored compiler"`, destination);
    }
    rmSync(join(source, 'packages/compiler/dist'), { recursive: true });
    const missing = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', archive[0]], {
      cwd: source, env: { ...process.env, RUNNER_TEMP: temporary }, encoding: 'utf8', timeout: 5000,
    });
    if (missing.error) throw missing.error;
    assert.notEqual(missing.status, 0, 'A missing candidate must fail before upload');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('long package jobs expose each phase without changing command order', () => {
  const management = readFileSync(new URL('../workflows/management-api.yml', import.meta.url), 'utf8');
  const phased = ['prepare_script', 'typecheck_script', 'test_script', 'build_script', 'acceptance_script'];
  for (const name of ['Project CLI', 'App Compiler']) {
    const entry = management.split(`          - name: ${name}\n`)[1]?.split('          - name: ')[0];
    assert.ok(entry);
    assert.doesNotMatch(entry, /^ {12}script:/m);
    let previous = -1;
    for (const phase of phased) {
      const index = entry.indexOf(`${phase}: |`);
      assert.ok(index > previous, `${name}: ${phase} must run in original order`);
      previous = index;
      assert.match(management, new RegExp(`if: \\$\\{\\{ matrix\\.${phase} != '' \\}\\}`));
      assert.match(management, new RegExp(`run: \\$\\{\\{ matrix\\.${phase} \\}\\}`));
    }
    assert.match(entry, /bun run typecheck/);
    assert.match(entry, /bun test/);
    assert.match(entry, /bun run build/);
    assert.match(entry, /audit_dependencies.ts/);
  }
  assert.match(management, /Run package checks\n {8}if: \$\{\{ matrix.script != '' \}\}/);
  assert.match(management, /scripts\/check_app_starter.ts/);
  assert.match(management, /typecheck:application-releases/);
  assert.match(management, /delivery-package.acceptance.mjs/);
});
