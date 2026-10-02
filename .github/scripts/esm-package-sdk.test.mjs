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
  main: './dist/index.js', module: './dist/index.js', types: './dist/index.d.ts',
  engines: { node: SDK_NODE_RANGE },
  exports: Object.fromEntries(Object.entries(SDK_ENTRYPOINTS).map(([path, file]) => [path, {
    types: `./dist/${file}.d.ts`, 'module-sync': `./dist/${file}.js`,
    import: `./dist/${file}.js`, default: `./dist/${file}.js`,
  }])),
});
const inventory = ['package.json', ...Object.values(SDK_ENTRYPOINTS).flatMap(file => [
  `dist/${file}.js`, `dist/${file}.d.ts`,
])];

test('SDK promises modern require/import without granting a CJS build exception', () => {
  assert.deepEqual(checkEsmManifest(manifest()), []);
  assert.deepEqual(checkEsmPack(manifest(), inventory), []);
  assert.match(checkEsmPack(manifest(), [...inventory, 'dist/index.cjs']).join('\n'), /unexpected CommonJS artifact/);
  assert.match(checkEsmManifest({ ...manifest(), scripts: { build: 'bun build index.ts --format cjs' } }).join('\n'), /CommonJS builds/);
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

test('every public SDK subpath requires module-sync with the same ESM implementation', () => {
  for (const path of Object.keys(SDK_ENTRYPOINTS)) {
    for (const field of ['module-sync', 'import', 'default', 'types']) {
      const candidate = manifest();
      candidate.exports[path][field] = './dist/other.js';
      assert.match(checkSdkModuleContract(candidate).join('\n'), /share the reviewed ESM entry/);
      delete candidate.exports[path][field];
      assert.match(checkSdkModuleContract(candidate).join('\n'), /share the reviewed ESM entry/);
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

// These dependency-free fixtures exercise the acceptance harness and Node's
// real loader. CI separately runs the same consumers against actual tarballs.
async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), 'supacloud-sdk-compat-'));
  try {
    const sdk = join(directory, 'node_modules', '@supacloud', 'js');
    const contracts = join(directory, 'node_modules', '@supacloud', 'contracts');
    await mkdir(join(sdk, 'dist'), { recursive: true });
    await mkdir(contracts, { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(sdk, 'package.json'), JSON.stringify(manifest()));
    await writeFile(join(sdk, 'dist', 'index.js'), 'export function createSupaCloudClient() { return {}; }\n');
    await writeFile(join(sdk, 'dist', 'task-events.js'), 'export class TaskEventError extends Error { constructor(status, code) { super(code); this.status = status; } }\n');
    await writeFile(join(contracts, 'package.json'), JSON.stringify({ name: '@supacloud/contracts', type: 'module', exports: { './client': { import: './client.js' } } }));
    await writeFile(join(contracts, 'client.js'), 'export function createAuthoritativeCommandClient() {}\nexport class CommandAuthenticationError extends Error {}\n');
    await writeFile(join(sdk, 'dist', 'contracts.js'), 'export * from "@supacloud/contracts/client";\n');
    await writeFile(join(sdk, 'dist', 'reactive.js'), 'export function observeQuery() {}\n');
    await writeSdkConsumers(directory);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const run = file => execFileSync(process.execPath, [file], {
      cwd: directory, env, encoding: 'utf8', timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await work({ directory, sdk, contracts, run });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

for (const file of ['sdk-require-first.cjs', 'sdk-import-first.mjs']) {
  test(`native loader shares all SDK identities: ${file}`, () => fixture(async ({ run }) => {
    assert.match(run(file), /SDK synchronous require\/import compatibility passed/);
  }));
}

for (const transitive of [false, true]) {
  test(`cold require rejects ${transitive ? 'transitive' : 'direct'} top-level await`, () => fixture(async ({ sdk, run }) => {
    if (transitive) {
      await writeFile(join(sdk, 'dist', 'async.js'), 'await Promise.resolve(); export const ready = true;\n');
      await writeFile(join(sdk, 'dist', 'index.js'), 'export { ready } from "./async.js"; export function createSupaCloudClient() {}\n');
    } else {
      await writeFile(join(sdk, 'dist', 'index.js'), 'await Promise.resolve(); export function createSupaCloudClient() {}\n');
    }
    assert.throws(() => run('sdk-require-first.cjs'), error => /ERR_REQUIRE_ASYNC_MODULE/.test(String(error.stderr)));
  }));
}

test('an async CJS shim cannot fake the synchronous SDK contract', () => fixture(async ({ sdk, run }) => {
  const candidate = manifest();
  candidate.exports['.'] = { import: './dist/index.js', require: './dist/shim.cjs' };
  await writeFile(join(sdk, 'package.json'), JSON.stringify(candidate));
  await writeFile(join(sdk, 'dist', 'shim.cjs'), 'module.exports = import("./index.js");\n');
  assert.throws(() => run('sdk-require-first.cjs'), error => /require must not return a Promise/.test(String(error.stderr)));
}));

test('independently bundled CJS/ESM functions are detected as an identity split', () => fixture(async ({ sdk, run }) => {
  const candidate = manifest();
  candidate.exports['.'] = { import: './dist/index.js', require: './dist/split.cjs' };
  await writeFile(join(sdk, 'package.json'), JSON.stringify(candidate));
  await writeFile(join(sdk, 'dist', 'split.cjs'), 'exports.createSupaCloudClient = function createSupaCloudClient() {};\n');
  assert.throws(() => run('sdk-require-first.cjs'), error => /shared identity/.test(String(error.stderr)));
}));

test('duplicating the contracts implementation is detected across SDK/shared boundaries', () => fixture(async ({ sdk, run }) => {
  await writeFile(join(sdk, 'dist', 'contracts.js'), 'export function createAuthoritativeCommandClient() {}\nexport class CommandAuthenticationError extends Error {}\n');
  assert.throws(() => run('sdk-require-first.cjs'), error => /shared protocol identity/.test(String(error.stderr)));
}));
