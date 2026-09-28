import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareCommandPackage } from './prepare-command-package.mjs';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const bun = process.versions.bun ? process.execPath : (process.env.BUN_BINARY ?? 'bun');
const temporary = await mkdtemp(join(tmpdir(), 'delivery-package-consumer-'));
const consumer = join(temporary, 'consumer');
try {
  const delivery = JSON.parse(await readFile(join(repo, 'packages/delivery/package.json'), 'utf8'));
  const compiler = JSON.parse(await readFile(join(repo, 'packages/compiler/package.json'), 'utf8'));
  const prepared = prepareCommandPackage(compiler, new Map([['@supacloud/delivery', delivery]]));
  assert.deepEqual(prepared.required, [`@supacloud/delivery@${delivery.version}`]);
  assert.equal(prepared.package.dependencies['@supacloud/delivery'], delivery.version);
  const tarballs = [];
  for (const [name, manifest, directories] of [
    ['delivery', delivery, ['src', 'dist']],
    ['compiler', prepared.package, ['dist']],
  ]) {
    const stage = join(temporary, 'staging', name);
    await mkdir(stage, { recursive: true });
    for (const directory of directories) {
      await cp(join(repo, 'packages', name, directory), join(stage, directory), { recursive: true });
    }
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest));
    const tarball = join(temporary, `${name}.tgz`);
    await run(bun, ['pm', 'pack', '--ignore-scripts', '--filename', tarball], { cwd: stage, timeout: 60_000 });
    tarballs.push(tarball);
  }
  // The consumer has no sibling source tree, symlinks, or dependency overrides.
  await rm(join(temporary, 'staging'), { recursive: true });
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock=false', '--registry=https://registry.npmjs.org', ...tarballs, '@types/bun@1.4.2'],
  { cwd: consumer, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  const installed = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'));
  assert.equal(installed.overrides, undefined);
  await writeFile(join(consumer, 'consumer.ts'), `
import { parseDeliveryBuildManifest, type DeliveryBuildManifest } from "@supacloud/compiler";
import { readDeliveryExecutableArchive } from "@supacloud/delivery";
const parsed: DeliveryBuildManifest = parseDeliveryBuildManifest({});
const unactivated: false = parsed.deploymentReady;
// @ts-expect-error The immutable manifest is not platform activation evidence.
const activated: true = parsed.deploymentReady;
const read = readDeliveryExecutableArchive("missing");
void [unactivated, activated, read];
`);
  await run('node', ['--input-type=module', '-e', `
import ts from "@typescript/typescript6";
import { readDeliveryExecutableArchive } from "@supacloud/delivery";
import { parseDeliveryBuildManifest } from "@supacloud/compiler";
if (typeof readDeliveryExecutableArchive !== "function" || typeof parseDeliveryBuildManifest !== "function") {
  throw new Error("Missing package exports");
}
const program = ts.createProgram(["consumer.ts"], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
  skipLibCheck: true, noEmit: true, types: ["bun"],
});
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
  getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\\n",
}));
`], { cwd: consumer, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  console.log('Delivery/compiler tarballs: isolated npm install, Node exports and public types passed without overrides.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
