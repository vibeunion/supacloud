import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkEsmManifest, checkEsmPack } from './esm-package-policy.mjs';
import {
  SDK_NODE_RANGE, SDK_ENTRYPOINTS, checkSdkModuleContract,
  sdkRuntimeConsumer, sdkTypeConsumer, writeSdkConsumers, checkConsumerTypes,
} from './esm-package-sdk.mjs';

const manifest = () => ({
  name: '@supacloud/js', version: '1.0.0', type: 'module',
  main: './dist/index.cjs', module: './dist/index.mjs', types: './dist/index.d.mts',
  engines: { node: SDK_NODE_RANGE },
  exports: Object.fromEntries(Object.entries(SDK_ENTRYPOINTS).map(([path, file]) => [path, {
    import: { types: `./dist/${file}.d.mts`, default: `./dist/${file}.mjs` },
    require: { types: `./dist/${file}.d.cts`, default: `./dist/${file}.cjs` },
  }])),
});
const inventory = ['package.json', ...Object.values(SDK_ENTRYPOINTS).flatMap(file => [
  `dist/${file}.mjs`, `dist/${file}.cjs`, `dist/${file}.d.mts`, `dist/${file}.d.cts`,
])];

test('SDK publishes explicit dual MJS/CJS require/import conditions', () => {
  assert.deepEqual(checkEsmManifest(manifest()), []);
  assert.deepEqual(checkEsmPack(manifest(), inventory), []);
  assert.deepEqual(checkEsmPack(manifest(), inventory), []);
  assert.deepEqual(checkEsmManifest({ ...manifest(), scripts: { build: 'bun build index.ts --format cjs' } }), []);
});

test('the real SDK manifest preserves its reviewed public paths and runtime floor', async () => {
  const path = fileURLToPath(new URL('../../packages/supacloud-js/package.json', import.meta.url));
  assert.deepEqual(checkEsmManifest(JSON.parse(await readFile(path, 'utf8'))), []);
});

test('SDK must not promise synchronous loading without its documented Node floor', () => {
  for (const engines of [undefined, {}, { node: '>=18' }, { node: '>=22.0.0' }]) {
    assert.match(checkSdkModuleContract({ ...manifest(), engines }).join('\n'), /Node engine/);
  }
});

test('every public SDK subpath requires matching MJS/CJS conditions', () => {
  for (const path of Object.keys(SDK_ENTRYPOINTS)) {
    for (const field of ['import', 'require']) {
      const candidate = manifest();
      candidate.exports[path][field] = { types: './dist/other.d.mts', default: './dist/other.mjs' };
      assert.match(checkSdkModuleContract(candidate).join('\n'), /matching MJS\/CJS/);
      delete candidate.exports[path][field];
      assert.match(checkSdkModuleContract(candidate).join('\n'), /matching MJS\/CJS/);
    }
  }
});

test('earlier default/node conditions and an untested extra subpath fail closed', () => {
  const candidate = manifest();
  candidate.exports['.'] = { node: './dist/other.js', ...candidate.exports['.'] };
  assert.notDeepEqual(checkSdkModuleContract(candidate), []);
  const reordered = manifest();
  reordered.exports['.'] = { default: './dist/index.js', ...reordered.exports['.'] };
  assert.notDeepEqual(checkSdkModuleContract(reordered), []);
  const extra = manifest();
  extra.exports['./unreviewed'] = { import: './dist/new.js' };
  assert.match(checkSdkModuleContract(extra).join('\n'), /acceptance inventory/);
});

test('SDK main/module/types fallbacks and missing exports cannot bypass the contract', () => {
  for (const field of ['main', 'module', 'types', 'exports']) {
    const candidate = manifest();
    delete candidate[field];
    assert.notDeepEqual(checkSdkModuleContract(candidate), []);
  }
  assert.deepEqual(checkSdkModuleContract({ name: '@supacloud/app' }), []);
});

test('acceptance invokes the real compiler for bundler and NodeNext consumers', () => {
  const calls = [];
  checkConsumerTypes('/consumer', '/compiler', (...args) => calls.push(args));
  assert.deepEqual(calls, [
    ['node', [join('/consumer', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join('/consumer', 'tsconfig.sdk.json')], '/consumer'],
    ['bun', ['run', 'tsc', '-p', join('/consumer', 'tsconfig.sdk.json'), '--skipLibCheck'], '/compiler'],
    ['bun', ['run', 'tsc', '-p', join('/consumer', 'tsconfig.json')], '/compiler'],
  ]);
});

test('a failed consumer compilation is never treated as a successful acceptance', () => {
  const failure = new Error('TypeScript rejected the consumer');
  assert.throws(() => checkConsumerTypes('/consumer', '/compiler', () => { throw failure; }), error => error === failure);
});

test('type consumers use actual CommonJS/ESM syntax and retain negative/any checks', () => {
  assert.match(sdkTypeConsumer(true), /import sdk = require/);
  assert.match(sdkTypeConsumer(false), /import \* as sdk/);
  for (const mode of [true, false]) {
    assert.match(sdkTypeConsumer(mode), /@ts-expect-error/);
    assert.match(sdkTypeConsumer(mode), /IsAny/);
    assert.match(sdkTypeConsumer(mode), /sameDatabaseType/);
    assert.match(sdkTypeConsumer(mode), /missing_table/);
  }
  assert.throws(() => sdkRuntimeConsumer('unsupported'), /Invalid SDK loader order/);
});

// Real tarball consumers in esm-package.acceptance.mjs cover native loading,
// both load orders, declarations and browser bundling.
test('runtime harness checks format-local identity and API parity', () => {
  for (const order of ['require-first', 'import-first']) {
    const source = sdkRuntimeConsumer(order);
    assert.match(source, /API parity/);
    assert.match(source, /CJS identity/);
    assert.match(source, /ESM identity/);
  }
});

// Run the harness against deliberately independent builds, then inject real
// packaging failures to prove that acceptance does not merely inspect metadata.
async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), 'supacloud-sdk-dual-'));
  try {
    const sdk = join(directory, 'node_modules', '@supacloud', 'js');
    const contracts = join(directory, 'node_modules', '@supacloud', 'contracts');
    for (const path of [sdk, contracts]) await mkdir(join(path, 'dist'), { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(sdk, 'package.json'), JSON.stringify(manifest()));
    const entries = { '.': 'index', './client': 'client', './browser': 'browser' };
    await writeFile(join(contracts, 'package.json'), JSON.stringify({
      type: 'module', exports: Object.fromEntries(Object.entries(entries).map(([path, file]) =>
        [path, { import: `./dist/${file}.mjs`, require: `./dist/${file}.cjs` }])),
    }));
    const implementations = {
      index: 'function createSupaCloudClient() { return {}; }',
      'task-events': 'class TaskEventError extends Error { constructor(status, code) { super(code); this.status = status; } }',
      reactive: 'function observeQuery() {}',
      query: 'function createSupaCloudQueryAdapter() {}',
    };
    for (const [file, source] of Object.entries(implementations)) {
      const name = source.match(/(?:function|class) (\w+)/)[1];
      await writeFile(join(sdk, 'dist', file + '.mjs'), `export ${source}\n`);
      await writeFile(join(sdk, 'dist', file + '.cjs'), `${source}\nexports.${name} = ${name};\n`);
    }
    for (const file of Object.values(entries)) {
      await writeFile(join(contracts, 'dist', file + '.mjs'), 'export function createAuthoritativeCommandClient() {}\n');
      await writeFile(join(contracts, 'dist', file + '.cjs'), 'exports.createAuthoritativeCommandClient = function() {};\n');
    }
    await writeFile(join(sdk, 'dist', 'contracts.mjs'), 'export * from "@supacloud/contracts/client";\n');
    await writeFile(join(sdk, 'dist', 'contracts.cjs'), 'module.exports = require("@supacloud/contracts/client");\n');
    await writeSdkConsumers(directory);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const run = file => execFileSync(process.execPath, [file], {
      cwd: directory, env, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await work({ directory, sdk, contracts, run });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

for (const file of ['sdk-require-first.cjs', 'sdk-import-first.mjs']) {
  test(`native dual builds preserve per-format contracts: ${file}`, () => fixture(async ({ run }) => {
    assert.match(run(file), /SDK synchronous require\/import compatibility passed/);
  }));
}

test('an asynchronous CJS shim fails acceptance', () => fixture(async ({ sdk, run }) => {
  await writeFile(join(sdk, 'dist', 'index.cjs'), 'module.exports = import("./index.mjs");\n');
  assert.throws(() => run('sdk-require-first.cjs'), error => /require must not return a Promise/.test(String(error.stderr)));
}));

test('a missing CJS public export fails API parity', () => fixture(async ({ sdk, run }) => {
  await writeFile(join(sdk, 'dist', 'reactive.cjs'), 'exports.wrong = function() {};\n');
  assert.throws(() => run('sdk-import-first.mjs'), error => /API parity/.test(String(error.stderr)));
}));

for (const extension of ['mjs', 'cjs']) {
  test(`duplicated ${extension} contracts fail format-local facade identity`, () => fixture(async ({ sdk, run }) => {
    await writeFile(join(sdk, 'dist', 'contracts.' + extension), extension === 'mjs'
      ? 'export function createAuthoritativeCommandClient() {}\n'
      : 'exports.createAuthoritativeCommandClient = function() {};\n');
    assert.throws(() => run('sdk-require-first.cjs'), error => /shared protocol identity/.test(String(error.stderr)));
  }));
}

test('Contracts uses the same strict dual-format contract', async () => {
  const path = fileURLToPath(new URL('../../packages/contracts/package.json', import.meta.url));
  const candidate = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(checkEsmManifest(candidate), []);
  for (const entry of Object.values(candidate.exports)) {
    entry.require.types = './dist/index.d.mts';
    assert.match(checkEsmManifest(candidate).join('\n'), /matching MJS\/CJS/);
  }
});

test('declaration copying rewrites re-exports, imports and nested import types', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'supacloud-dual-types-'));
  try {
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested', 'entry.d.ts'), `export * from '../other.js';
import type { A } from "../other.js";
export type B = import('../other.js').A;
import type { SupabaseClient } from '@supabase/supabase-js' with { "resolution-mode": "import" };
`);
    execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/copy-dual-declarations.mjs', import.meta.url)), directory]);
    for (const extension of ['m', 'c']) {
      const content = await readFile(join(directory, 'nested', `entry.d.${extension}ts`), 'utf8');
      assert.equal(content.match(new RegExp(`other\\.${extension}js`, 'g')).length, 3);
      assert.match(content, /resolution-mode": "import"/);
      assert.match(content, /@supabase\/supabase-js/);
    }
    await assert.rejects(readFile(join(directory, 'nested', 'entry.d.ts')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
