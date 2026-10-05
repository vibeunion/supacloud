import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../../packages/supacloud-lite/src/launcher.mjs', import.meta.url));

// Run the unmodified launcher in Node. A copy of Node stands in for Bun, so
// these process-boundary tests need neither network access nor a database.
async function fixture(t, program, { noBun = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'supacloud-esm-launcher-'));
  const children = [];
  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.allSettled(children.map(execution => execution.closed));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const dist = join(root, 'space # percent % Unicode 测试', 'dist');
  const bin = join(root, 'bin');
  const cwd = join(root, 'unrelated-working-directory');
  await Promise.all([mkdir(dist, { recursive: true }), mkdir(bin), mkdir(cwd)]);
  await copyFile(source, join(dist, 'launcher.mjs'));
  // The explicit .mjs marker must override an enclosing CommonJS scope.
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}');
  await writeFile(join(dist, 'cli.js'), program);
  if (!noBun) await copyFile(process.execPath, join(bin, process.platform === 'win32' ? 'bun.exe' : 'bun'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH' && key !== 'NODE_OPTIONS'));
  env.PATH = bin;
  return { dist, cwd, env, children };
}

function run(context, args = []) {
  const child = spawn(process.execPath, [join(context.dist, 'launcher.mjs'), ...args], {
    cwd: context.cwd, env: context.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; if (stdout.includes('ready\n')) readyResolve(); });
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const readiness = Promise.race([ready, closed.then(result => { throw new Error(`Exited before ready: ${JSON.stringify(result)}`); })]);
  readiness.catch(() => {}); // Tests of immediate exits do not wait for readiness.
  const execution = { child, closed, ready: readiness };
  context.children.push(execution);
  return execution;
}

test('ESM launcher preserves argv and resolves cli.js independently of cwd and URL characters', { timeout: 15000 }, async t => {
  const context = await fixture(t, 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
  const args = ['start', '--project-dir', 'space # percent % 测试', '; echo must-not-run', '--json'];
  const result = await run(context, args).closed;
  assert.equal(result.code, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
  const [actualCwd, expectedCwd] = process.platform === 'darwin'
    ? await Promise.all([realpath(observed.cwd), realpath(context.cwd)])
    : [observed.cwd, context.cwd];
  assert.deepEqual({ ...observed, cwd: actualCwd }, { args, cwd: expectedCwd });
});

test('ESM launcher preserves unsuccessful CLI exit codes', { timeout: 15000 }, async t => {
  const result = await run(await fixture(t, 'process.exitCode = 17;')).closed;
  assert.equal(result.code, 17, result.stderr);
});

test('ESM launcher reports a missing Bun executable without a module-loader failure', { timeout: 15000 }, async t => {
  const result = await run(await fixture(t, '', { noBun: true })).closed;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Bun executable not found on PATH/);
  assert.doesNotMatch(result.stderr, /require is not defined|__dirname is not defined|ERR_REQUIRE_ESM/);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`ESM launcher forwards ${signal} and waits for graceful child shutdown`, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const context = await fixture(t, `
      const keepAlive = setInterval(() => {}, 1000);
      setTimeout(() => process.exit(99), 6000).unref();
      process.once('${signal}', () => {
        setTimeout(() => { console.log('shutdown-complete'); clearInterval(keepAlive); }, 80);
      });
      console.log('ready');
    `);
    const execution = run(context);
    await execution.ready;
    execution.child.kill(signal);
    const result = await execution.closed;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /shutdown-complete/);
  });
}

test('ESM launcher reports an unexpected child signal as failure', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const result = await run(await fixture(t, "process.kill(process.pid, 'SIGTERM');")).closed;
  assert.equal(result.code, 1);
});

test('manifest and build script select the ESM launcher', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../packages/supacloud-lite/package.json', import.meta.url), 'utf8'));
  const build = await readFile(new URL('../../packages/supacloud-lite/scripts/build-launcher.ts', import.meta.url), 'utf8');
  assert.equal(manifest.bin['supacloud-lite'], 'dist/launcher.mjs');
  assert.match(build, /src\/launcher\.mjs/);
  assert.match(build, /dist\/launcher\.mjs/);
  assert.doesNotMatch(build, /launcher\.cjs/);
});
