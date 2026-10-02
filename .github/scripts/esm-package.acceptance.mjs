import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCommandPackage } from './prepare-command-package.mjs';
import { checkEsmPack } from './esm-package-policy.mjs';

// Run after building these packages. Installation is outside the checkout and
// uses real tarballs, never workspace links or source-resolution conditions.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directories = ['contracts', 'delivery', 'app', 'supacloud-js', 'compiler'];
const publicConsumers = new Set(['@supacloud/app', '@supacloud/js', '@supacloud/compiler']);
const scratch = await mkdtemp(join(tmpdir(), 'supacloud-esm-consumer-'));
const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
delete env.BUN_OPTIONS;

/** @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** @param {string} directory @param {string} destination */
function pack(directory, destination) {
  const reports = JSON.parse(run('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', destination,
  ], directory));
  assert.equal(reports.length, 1, 'npm pack must report exactly one package');
  const report = reports[0];
  assert.equal(basename(report.filename), report.filename, 'pack filename must not contain directories');
  assert.ok(Array.isArray(report.files), 'npm pack must report its file inventory');
  return { path: join(destination, report.filename), files: report.files.map(file => file.path) };
}

try {
  const raw = join(scratch, 'raw');
  const packed = join(scratch, 'packed');
  const consumer = join(scratch, 'consumer');
  await Promise.all([raw, packed, consumer].map(path => mkdir(path)));
  const siblings = new Map();
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(resolve(root, 'packages', directory, 'package.json'), 'utf8'));
    siblings.set(manifest.name, manifest);
  }

  const tarballs = [];
  const specifiers = [];
  for (const directory of directories) {
    const source = resolve(root, 'packages', directory);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const original = pack(source, raw);
    assert.deepEqual(checkEsmPack(manifest, original.files), [], `${manifest.name}: source pack contract`);
    const stage = join(scratch, directory);
    await mkdir(stage);
    run('tar', ['-xzf', original.path, '-C', stage], scratch);
    const stagePackage = join(stage, 'package');
    // Use the same dependency normalization as release; do not mutate checkout
    // manifests or accidentally resolve file:../contracts from the workspace.
    const prepared = prepareCommandPackage(manifest, siblings).package;
    await writeFile(join(stagePackage, 'package.json'), `${JSON.stringify(prepared, null, 2)}\n`);
    const artifact = pack(stagePackage, packed);
    assert.deepEqual(checkEsmPack(prepared, artifact.files), [], `${manifest.name}: release pack contract`);
    tarballs.push(artifact.path);
    if (publicConsumers.has(manifest.name)) {
      for (const subpath of Object.keys(manifest.exports)) {
        if (subpath === './package.json') continue;
        assert.ok(subpath === '.' || subpath.startsWith('./'), 'expected explicit public subpaths');
        specifiers.push(manifest.name + (subpath === '.' ? '' : subpath.slice(1)));
      }
    }
  }

  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'supacloud-esm-installed-consumer', version: '0.0.0', private: true, type: 'module',
  }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], consumer);
  for (const [name, expected] of siblings) {
    const path = join(consumer, 'node_modules', name);
    assert.equal((await lstat(path)).isSymbolicLink(), false, `${name}: installation must not be a workspace link`);
    const installed = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    assert.equal(installed.version, expected.version, `${name}: installation must use the candidate tarball`);
  }

  await writeFile(join(consumer, 'bridge.cjs'), 'module.exports = () => import("@supacloud/app");\n');
  await writeFile(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const specifiers = ${JSON.stringify(specifiers)};
const installedRoot = realpathSync(resolve('node_modules')) + sep;
for (const specifier of specifiers) {
  const path = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
  assert.ok(path.startsWith(installedRoot), specifier + ': must resolve inside the isolated installation');
  await import(specifier); // Type-only subpaths may legitimately export an empty namespace.
}
const app = await import('@supacloud/app');
const bridge = createRequire(import.meta.url)('./bridge.cjs');
const fromCommonJs = await bridge();
assert.equal(typeof app.InjectionToken, 'function');
assert.equal(typeof (await import('@supacloud/compiler')).analyzeProject, 'function');
assert.ok(Object.keys(await import('@supacloud/js')).length > 0);
assert.strictEqual(app.InjectionToken, fromCommonJs.InjectionToken);
const shared = await import('@supacloud/contracts/client');
const appContracts = await import('@supacloud/app/contracts');
const sdkContracts = await import('@supacloud/js/contracts');
assert.equal(typeof shared.createAuthoritativeCommandClient, 'function');
assert.strictEqual(appContracts.createAuthoritativeCommandClient, shared.createAuthoritativeCommandClient);
assert.strictEqual(sdkContracts.createAuthoritativeCommandClient, shared.createAuthoritativeCommandClient);
console.log('Installed ESM entrypoints and shared identities passed: ' + specifiers.length);
`);
  for (const runtime of ['node', 'bun']) console.log(`${runtime}: ${run(runtime, ['consumer.mjs'], consumer).trim()}`);

  await writeFile(join(consumer, 'consumer.ts'), specifiers.map((specifier, index) =>
    `import * as API${index} from ${JSON.stringify(specifier)};\nexport const exports${index}: string[] = Object.keys(API${index});`
  ).join('\n') + '\nimport { InjectionToken } from "@supacloud/app";\nexport const token = new InjectionToken<string>("esm-consumer");\n');
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true,
      noEmit: true, skipLibCheck: true, types: [],
    }, files: ['./consumer.ts'],
  }));
  run('bun', ['add', '--no-save', '--exact', '/node'], consumer);
  run('bun', ['run', 'tsc', '-p', join(consumer, 'tsconfig.json')], resolve(root, 'packages', 'app'));
  await writeFile(join(consumer, 'browser.ts'), [
    'export { HttpClient } from "@supacloud/app/browser";',
    'export { createAuthoritativeCommandClient } from "@supacloud/js/contracts";',
  ].join('\n'));
  run('bun', ['build', 'browser.ts', '--target', 'browser', '--format', 'esm', '--outfile', 'browser.mjs'], consumer);
  console.log('Installed declaration consumer and browser bundle passed.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
