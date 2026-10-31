import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { runTask } from './run.mjs';

const root = mkdtempSync(resolve(tmpdir(), 'supacloud-workspace-acceptance-'));
const put = (file, data) => {
  mkdirSync(dirname(resolve(root, file)), { recursive: true });
  writeFileSync(resolve(root, file), typeof data === 'string' ? data : JSON.stringify(data));
};
const run = (command, args, cwd = root, expectedSuccess = true) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if ((result.status === 0) !== expectedSuccess) {
    throw new Error(`Unexpected exit ${result.status}: ${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
};
const topology = { shared: [], left: ['shared'], right: ['shared'], app: ['left', 'right', 'sourceonly'], sourceonly: ['shared'], unrelated: [] };
const transitive = (name) => [...new Set(topology[name].flatMap((dependency) => [dependency, ...transitive(dependency)]))];
const readTrace = () => existsSync(resolve(root, 'trace.jsonl'))
  ? readFileSync(resolve(root, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : [];
function runTaskExpect(selector, task, expectedSuccess = true) {
  let failed;
  try {
    runTask(root, selector, task);
  } catch (error) {
    failed = error;
  }
  if (expectedSuccess && failed) throw failed;
  if (!expectedSuccess && !failed) throw new Error(`Expected ${selector}:${task} to fail`);
}
try {
  for (const [name, prerequisites] of Object.entries(topology)) {
    put(`packages/${name}/package.json`, {
      name: `@fixture/${name}`, version: '1.0.0', type: 'module',
      scripts: name === 'sourceonly' ? {} : { build: 'node build.mjs' },
      dependencies: Object.fromEntries(prerequisites.map((dependency) => [`@fixture/${dependency}`, `file:../${dependency}`])),
      overrides: Object.fromEntries(transitive(name).map((dependency) => [`@fixture/${dependency}`, `file:../${dependency}`])),
    });
    put(`packages/${name}/project.json`, { name: `@fixture/${name}`, tags: ['scope:fixture', 'type:library'] });
    put(`packages/${name}/build.mjs`, `import {appendFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';\nfor (const dependency of ${JSON.stringify(prerequisites)}) { if (!existsSync('../' + dependency + (dependency === 'sourceonly' ? '/node_modules/@fixture/shared/dist/ready' : '/dist/ready'))) throw new Error('Missing prerequisite: ' + dependency); }\nmkdirSync('dist', {recursive:true}); writeFileSync('dist/ready','built'); appendFileSync('../../trace.jsonl',JSON.stringify(${JSON.stringify(name)})+'\\n');\n`);
  }
  for (const name of Object.keys(topology)) run('bun', ['install', '--lockfile-only', '--ignore-scripts'], resolve(root, 'packages', name));
  rmSync(resolve(root, 'packages/app/node_modules'), { recursive: true, force: true });
  rmSync(resolve(root, 'packages/sourceonly/node_modules'), { recursive: true, force: true });
  runTaskExpect('@fixture/app', 'repo-prepare');
  assert.deepEqual(readTrace().sort(), ['left', 'right', 'shared']);
  assert.ok(!existsSync(resolve(root, 'packages/app/node_modules')));
  assert.ok(!existsSync(resolve(root, 'packages/app/dist')));
  assert.ok(existsSync(resolve(root, 'packages/sourceonly/node_modules/@fixture/shared/dist/ready')));
  for (let iteration = 0; iteration < 2; iteration++) {
    rmSync(resolve(root, 'trace.jsonl'), { force: true });
    for (const name of Object.keys(topology)) rmSync(resolve(root, 'packages', name, 'dist'), { recursive: true, force: true });
    runTaskExpect('@fixture/app', 'repo-build');
    const trace = readTrace();
    assert.deepEqual([...trace].sort(), ['app', 'left', 'right', 'shared']);
    assert.ok(trace.indexOf('shared') < trace.indexOf('left'));
    assert.ok(trace.indexOf('shared') < trace.indexOf('right'));
    assert.equal(trace.at(-1), 'app');
    assert.ok(existsSync(resolve(root, 'packages/app/dist/ready')));
  }
  put('packages/shared/build.mjs', "throw new Error('intentional prerequisite failure');\n");
  rmSync(resolve(root, 'trace.jsonl'), { force: true });
  rmSync(resolve(root, 'packages/app/dist'), { recursive: true, force: true });
  runTaskExpect('@fixture/app', 'repo-build', false);
  assert.ok(!readTrace().includes('app'));
  assert.ok(!existsSync(resolve(root, 'packages/app/dist/ready')));
  console.log('PASS: Bun dependency order, shared-task deduplication, prepare-only execution, source-only prerequisites, live rebuild and failure propagation.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
