import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SDK_NODE_RANGE = '>=22.12.0';
export const SDK_ENTRYPOINTS = Object.freeze({
  '.': 'index', './task-events': 'task-events', './contracts': 'contracts', './reactive': 'reactive',
});
export const CONTRACTS_ENTRYPOINTS = Object.freeze({ '.': 'index', './client': 'client', './browser': 'browser' });
export const SDK_SPECIFIERS = Object.freeze(Object.keys(SDK_ENTRYPOINTS).map(
  path => '@supacloud/js' + (path === '.' ? '' : path.slice(1)),
));

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Public client packages publish native MJS/CJS with matching declarations.
 * Installed-consumer processes verify their actual dependency graphs.
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function checkSdkModuleContract(manifest) {
  const name = manifest.name;
  const entries = name === '@supacloud/js' ? SDK_ENTRYPOINTS
    : name === '@supacloud/contracts' ? CONTRACTS_ENTRYPOINTS : undefined;
  if (!entries) return [];
  const errors = [];
  if (name === '@supacloud/js' && (!isRecord(manifest.engines) || manifest.engines.node !== SDK_NODE_RANGE)) {
    errors.push(`${name}: documented Node engine must be ${SDK_NODE_RANGE}`);
  }
  const exports = manifest.exports;
  if (!isRecord(exports)) return [...errors, `${name}: explicit exports are required`];
  if (Object.keys(exports).sort().join(',') !== Object.keys(entries).sort().join(',')) {
    errors.push(`${name}: public subpaths must match the consumer acceptance inventory`);
  }
  for (const [path, file] of Object.entries(entries)) {
    const expected = {
      import: { types: `./dist/${file}.d.mts`, default: `./dist/${file}.mjs` },
      require: { types: `./dist/${file}.d.cts`, default: `./dist/${file}.cjs` },
    };
    // Exact order prevents a default condition from shadowing either loader.
    if (!isRecord(exports[path]) || JSON.stringify(exports[path]) !== JSON.stringify(expected)) {
      errors.push(`${name}${path}: import/require must point to matching MJS/CJS runtime and declarations`);
    }
  }
  const fallbacks = { main: './dist/index.cjs', module: './dist/index.mjs', types: './dist/index.d.mts' };
  for (const [field, target] of Object.entries(fallbacks)) {
    if (manifest[field] !== target) errors.push(`${name}.${field}: expected ${target}`);
  }
  return errors;
}

/** @param {'require-first' | 'import-first'} order */
export function sdkRuntimeConsumer(order) {
  if (order !== 'require-first' && order !== 'import-first') throw new Error('Invalid SDK loader order');
  const header = order === 'require-first' ? `
'use strict';
const assert = require('node:assert/strict');
const specs = ${JSON.stringify([...SDK_SPECIFIERS, '@supacloud/contracts', '@supacloud/contracts/client', '@supacloud/contracts/browser'])};
// Deliberately before any dynamic import: this proves cold synchronous loading.
const required = specs.map(spec => require(spec));
(async () => {
const imported = await Promise.all(specs.map(spec => import(spec)));
` : `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const specs = ${JSON.stringify([...SDK_SPECIFIERS, '@supacloud/contracts', '@supacloud/contracts/client', '@supacloud/contracts/browser'])};
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
  assert.strictEqual(require(spec), cjs, spec + ': CJS identity');
  assert.strictEqual(await import(spec), esm, spec + ': ESM identity');
  assert.ok(require.resolve(spec).endsWith('.cjs'), spec + ': native CJS resolution');
  for (const key of Object.keys(esm)) assert.equal(typeof cjs[key], typeof esm[key], spec + ': export kind');
}
for (const modules of [required, imported]) {
  assert.equal(typeof modules[0].createSupaCloudClient, 'function');
  const error = new modules[1].TaskEventError(400, 'COMPATIBILITY_TEST');
  assert.ok(error instanceof modules[1].TaskEventError);
  assert.equal(error.status, 400);
  assert.equal(error.message, 'COMPATIBILITY_TEST');
  for (const key of Object.keys(modules[2])) {
    assert.strictEqual(modules[2][key], modules[5][key], 'contracts: shared protocol identity ' + key);
  }
}
console.log('SDK synchronous require/import compatibility passed: ${order}');
` + (order === 'require-first' ? `
})().catch(error => { console.error(error); process.exitCode = 1; });
` : '');
}

/** @param {boolean} commonjs */
export function sdkTypeConsumer(commonjs) {
  const imports = commonjs
    ? `import sdk = require('@supacloud/js');\nimport events = require('@supacloud/js/task-events');\nimport contracts = require('@supacloud/js/contracts');\nimport upstream = require('@supabase/supabase-js');\nimport reactive = require('@supacloud/js/reactive');`
    : `import * as sdk from '@supacloud/js';\nimport * as events from '@supacloud/js/task-events';\nimport * as contracts from '@supacloud/js/contracts';\nimport * as upstream from '@supabase/supabase-js';\nimport * as reactive from '@supacloud/js/reactive';`;
  const oppositeImport = `
import type { SupabaseClient as OppositeClient } from '@supabase/supabase-js' with { "resolution-mode": "${commonjs ? 'import' : 'require'}" };
`;
  return imports + oppositeImport + `
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
declare const oppositeClient: OppositeClient;
export const oppositeSdk = sdk.createSupaCloudClient({ supabase: oppositeClient, projectRef: 'abcd1234', managementApiUrl: 'https://management.example.invalid' });
export const preservedOpposite: OppositeClient = oppositeSdk.supabase;

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
export const query = reactive.observeQuery(signal => typedSdk.supabase.from('notes').select('id').abortSignal(signal));
query.subscribe(response => {
  const id: number | undefined = response.data?.[0]?.id;
  // @ts-expect-error Selecting id does not expose title.
  response.data?.[0]?.title;
});
// @ts-expect-error Query observation requires a lazy query factory.
reactive.observeQuery(Promise.resolve({ error: null }));
// These fail if export resolution silently degrades to any.
type IsAny<T> = 0 extends (1 & T) ? true : false;
export const reactiveHasTypes: IsAny<typeof reactive.observeQuery> = false;
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
