import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveLiteCommand } from '../../packages/cli/src/shared/tools/lite-cli-command.ts';

async function fixture(t, entry = 'dist/launcher.mjs') {
  const workdir = await mkdtemp(join(tmpdir(), 'supacloud-lite-bin-'));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const root = join(workdir, 'node_modules', '@supacloud', 'lite');
  await mkdir(join(root, 'dist'), { recursive: true });
  const manifest = { name: '@supacloud/lite', type: 'module', bin: { 'supacloud-lite': entry } };
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  return { workdir, root, manifest };
}

test('resolves the declared ESM bin, including .mjs and module-scoped .js', async t => {
  for (const entry of ['dist/launcher.mjs', './dist/launcher.js']) {
    const context = await fixture(t, entry);
    const executable = join(context.root, entry);
    await writeFile(executable, 'export {};');
    assert.deepEqual(resolveLiteCommand(context.workdir, {}), [process.execPath, executable]);
  }
});

test('explicit binary wins and absent local packages retain PATH discovery', async t => {
  const { workdir } = await fixture(t);
  assert.deepEqual(resolveLiteCommand(workdir, { SUPACLOUD_LITE_CLI_BIN: ' /opt/lite ' }), ['/opt/lite']);
  assert.throws(() => resolveLiteCommand(workdir, { SUPACLOUD_LITE_CLI_BIN: 'bad\0path' }), /Invalid/);
  assert.deepEqual(resolveLiteCommand(join(workdir, 'no-package'), {}), ['supacloud-lite']);
});

test('old installed package metadata still resolves without shipping a CJS fallback', async t => {
  const context = await fixture(t, 'dist/launcher.cjs');
  const executable = join(context.root, 'dist/launcher.cjs');
  await writeFile(executable, '// Compatibility fixture for an older installed release.');
  assert.deepEqual(resolveLiteCommand(context.workdir, {}), [process.execPath, executable]);
});

test('missing local bin fails explicitly instead of running an unrelated global install', async t => {
  const { workdir } = await fixture(t);
  assert.throws(() => resolveLiteCommand(workdir, {}), /bin is missing/);
});

test('rejects malformed metadata and bins outside the installed package', async t => {
  const context = await fixture(t);
  for (const entry of ['../outside.mjs', '../../outside.mjs', context.root, '', '.', 'bad\0path']) {
    await writeFile(join(context.root, 'package.json'), JSON.stringify({ ...context.manifest, bin: { 'supacloud-lite': entry } }));
    assert.throws(() => resolveLiteCommand(context.workdir, {}), /bin/);
  }
  for (const manifest of [{ name: 'other', bin: {} }, null, { name: '@supacloud/lite', bin: [] }]) {
    await writeFile(join(context.root, 'package.json'), JSON.stringify(manifest));
    assert.throws(() => resolveLiteCommand(context.workdir, {}), /manifest/);
  }
  await writeFile(join(context.root, 'package.json'), '{');
  assert.throws(() => resolveLiteCommand(context.workdir, {}), SyntaxError);
});
