import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SDK_NODE_RANGE = '>=22.12.0';
export const SDK_ENTRYPOINTS = Object.freeze({
  '.': 'index', './task-events': 'task-events', './contracts': 'contracts', './reactive': 'reactive',
});
export const SDK_SPECIFIERS = Object.freeze(Object.keys(SDK_ENTRYPOINTS).map(
  path => '@supacloud/js' + (path === '.' ? '' : path.slice(1)),
));

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A public SDK promises two loading APIs, not two independent implementations.
 * Actual synchronous loadability (including dependencies) is checked in fresh
 * installed-consumer processes. Metadata alone cannot prove absence of TLA.
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function checkSdkModuleContract(manifest) {
  if (manifest.name !== '@supacloud/js') return [];
  const errors = [];
  if (!isRecord(manifest.engines) || manifest.engines.node !== SDK_NODE_RANGE) {
    errors.push(`@supacloud/js: documented Node engine must be ${SDK_NODE_RANGE}`);
  }
  const exports = manifest.exports;
  if (!isRecord(exports)) return [...errors, '@supacloud/js: explicit SDK exports are required'];
  if (Object.keys(exports).sort().join(',') !== Object.keys(SDK_ENTRYPOINTS).sort().join(',')) {
    errors.push('@supacloud/js: public subpaths must match the SDK consumer acceptance inventory');
  }
  for (const [path, file] of Object.entries(SDK_ENTRYPOINTS)) {
    const entry = exports[path];
    const expected = {
      types: `./dist/${file}.d.ts`, 'module-sync': `./dist/${file}.js`,
      import: `./dist/${file}.js`, default: `./dist/${file}.js`,
    };
    // Exact conditions/order prevent an earlier node/default condition from
    // silently diverting one loader to a different implementation.
    if (!isRecord(entry) || JSON.stringify(entry) !== JSON.stringify(expected)) {
      errors.push(`@supacloud/js${path}: types, module-sync, import and default must share the reviewed ESM entry in that order`);
    }
  }
  for (const [field, target] of Object.entries({ main: './dist/index.js', module: './dist/index.js', types: './dist/index.d.ts' })) {
    if (manifest[field] !== target) errors.push(`@supacloud/js.${field}: expected ${target}`);
  }
  return errors;
}

/** @param {'require-first' | 'import-first'} order */
export function sdkRuntimeConsumer(order) {
  if (order !== 'require-first' && order !== 'import-first') throw new Error('Invalid SDK loader order');
  const header = order === 'require-first' ? `
'use strict';
const assert = require('node:assert/strict');
const specs = ${JSON.stringify(SDK_SPECIFIERS)};
// Deliberately before any dynamic import: this proves cold synchronous loading.
const required = specs.map(spec => require(spec));
(async () => {
const imported = await Promise.all(specs.map(spec => import(spec)));
` : `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const specs = ${JSON.stringify(SDK_SPECIFIERS)};
const imported = await Promise.all(specs.map(spec => import(spec)));
const required = specs.map(spec => require(spec));
`;
  return header + `
for (const [index, spec] of specs.entries()) {
  const esm = imported[index], cjs = required[index];
  assert.notEqual(typeof cjs.then, 'function', spec + ': require must not return a Promise');
  assert.ok(Object.keys(esm).length > 0, spec + ': runtime exports must exist');
  assert.deepEqual(Object.keys(cjs).filter(key => key !== '__esModule').sort(),
    Object.keys(esm).filter(key => key !== '__esModule').sort(), spec + ': API parity');
  for (const key of Object.keys(esm)) assert.strictEqual(cjs[key], esm[key], spec + '.' + key + ': shared identity');
}
assert.equal(typeof required[0].createSupaCloudClient, 'function');
const cjsError = new required[1].TaskEventError(400, 'COMPATIBILITY_TEST');
assert.ok(cjsError instanceof imported[1].TaskEventError);
const esmError = new imported[1].TaskEventError(400, 'COMPATIBILITY_TEST');
assert.ok(esmError instanceof required[1].TaskEventError);
const shared = await import('@supacloud/contracts/client');
for (const key of Object.keys(imported[2])) {
  assert.strictEqual(required[2][key], shared[key], 'contracts: shared protocol identity ' + key);
}
console.log('SDK synchronous require/import compatibility passed: ${order}');
` + (order === 'require-first' ? `
})().catch(error => { console.error(error); process.exitCode = 1; });
` : '');
}

/** @param {boolean} commonjs */
export function sdkTypeConsumer(commonjs) {
  const imports = commonjs
    ? `import sdk = require('@supacloud/js');\nimport events = require('@supacloud/js/task-events');\nimport contracts = require('@supacloud/js/contracts');\nimport upstream = require('@supabase/supabase-js');`
    : `import * as sdk from '@supacloud/js';\nimport * as events from '@supacloud/js/task-events';\nimport * as contracts from '@supacloud/js/contracts';\nimport * as upstream from '@supabase/supabase-js';`;
  return imports + `
// The normal integration must type-check too, not just reject invalid calls.
const upstreamClient = upstream.createClient('https://sdk-compat.example.invalid', 'test-anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
export const integratedClient = sdk.createSupaCloudClient({
  supabase: upstreamClient, projectRef: 'abcd1234', managementApiUrl: 'https://management.example.invalid',
});
// The precise caller client and database schema must survive the adapter.
export const sameClientType: typeof upstreamClient = integratedClient.supabase;
export const workflows = new sdk.SupaCloudWorkflowsClient(upstreamClient);
export const artifacts = new sdk.SupaCloudArtifactsClient(upstreamClient);
type Database = { public: {
  Tables: { notes: { Row: { id: number; title: string }; Insert: { id?: number; title: string };
    Update: { title?: string }; Relationships: [] } };
  Views: {}; Functions: {}; Enums: {}; CompositeTypes: {};
} };
const typedUpstream = upstream.createClient<Database>('https://sdk-compat.example.invalid', 'test-anon-key');
const typedSdk = sdk.createSupaCloudClient({ supabase: typedUpstream,
  projectRef: 'abcd1234', managementApiUrl: 'https://management.example.invalid' });
export const sameDatabaseType: typeof typedUpstream = typedSdk.supabase;
// @ts-expect-error Database table names must stay checked across the adapter.
typedSdk.supabase.from('missing_table');
// These fail if export resolution silently degrades to any.
type IsAny<T> = 0 extends (1 & T) ? true : false;
export const factoryHasTypes: IsAny<typeof sdk.createSupaCloudClient> = false;
export const contractHasTypes: IsAny<typeof contracts.createAuthoritativeCommandClient> = false;
export const scopeHasTypes: IsAny<typeof contracts.createCommandScope> = false;
export const clientHasTypes: IsAny<ReturnType<typeof sdk.createSupaCloudClient>> = false;
export const resultHasTypes: IsAny<sdk.SupaCloudTaskSnapshot<{ id: string }>['raw']['result']> = false;
export const result: sdk.SupaCloudTaskSnapshot<{ id: string }>['raw']['result'] = { id: 'typed' };
// @ts-expect-error Task result generics must not be erased.
export const badResult: sdk.SupaCloudTaskSnapshot<{ id: string }>['raw']['result'] = { id: 42 };
export const error: Error = new events.TaskEventError(400, 'TEST');
// @ts-expect-error Status must remain a number in both loaders.
new events.TaskEventError('400', 'TEST');
// @ts-expect-error SDK configuration must remain checked.
sdk.createSupaCloudClient(42);
`;
}

/** @param {string} directory */
export async function writeSdkConsumers(directory) {
  for (const [path, source] of Object.entries({
    'sdk-require-first.cjs': sdkRuntimeConsumer('require-first'),
    'sdk-import-first.mjs': sdkRuntimeConsumer('import-first'),
    'sdk-consumer.cts': sdkTypeConsumer(true),
    'sdk-consumer.mts': sdkTypeConsumer(false),
  })) await writeFile(join(directory, path), source);
  await writeFile(join(directory, 'tsconfig.sdk.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, noEmit: true, skipLibCheck: false, types: ['node'],
    }, files: ['./sdk-consumer.cts', './sdk-consumer.mts'],
  }));
}

/**
 * Compilation failures must abort acceptance; generating a tsconfig is not a
 * type check. The runner is injectable so regression tests exercise failure.
 * @param {string} consumer
 * @param {string} compilerDirectory
 * @param {(command: string, args: string[], cwd: string) => unknown} run
 */
export function checkConsumerTypes(consumer, compilerDirectory, run) {
  console.log('SDK type matrix: TS 5.8.3 strict libraries; TS 7 consumers with skipLibCheck (upstream WebAuthn conflict).');
  // TS 5.8 is the first stable NodeNext model covering require(ESM). Check
  // the entire declaration graph, including upstream libraries, at that floor.
  run('node', [join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', join(consumer, 'tsconfig.sdk.json')], consumer);
  // Current upstream auth-js WebAuthn declarations conflict with TS 7 lib.dom.
  // Keep current-compiler consumer/negative/any checks without pretending that
  // its third-party declaration audit passes. The strict floor above still runs.
  run('bun', ['run', 'tsc', '-p', join(consumer, 'tsconfig.sdk.json'), '--skipLibCheck'], compilerDirectory);
  run('bun', ['run', 'tsc', '-p', join(consumer, 'tsconfig.json')], compilerDirectory);
}
