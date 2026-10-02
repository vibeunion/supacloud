import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const commonJsFile = /\.(?:cjs|cts)(?:\.map)?$/i;
const commonJsBuild = /--format(?:\s*=\s*|\s+)["']?(?:cjs|commonjs)\b/i;

// This process launcher is not a second implementation of a library entrypoint.
const allowedBins = new Map([
  ['@supacloud/lite', new Set(['dist/launcher.cjs'])],
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {string} location @param {string[]} errors */
function checkExports(value, location, errors) {
  if (typeof value === 'string') {
    if (commonJsFile.test(value)) errors.push(`${location}: CommonJS target ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkExports(entry, `${location}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [condition, target] of Object.entries(value)) {
    if (condition === 'require') errors.push(`${location}.require: use the shared ESM entrypoint instead`);
    checkExports(target, `${location}.${condition}`, errors);
  }
}

/**
 * Inspect first-party library metadata only, never dependency code or fixtures.
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function checkEsmManifest(manifest) {
  if (!isRecord(manifest)) return ['Invalid package manifest'];
  const name = manifest['name'];
  if (typeof name !== 'string' || !name.startsWith('@supacloud/') || manifest['private'] === true) return [];
  const errors = [];
  if (manifest['exports'] !== undefined || manifest['main'] !== undefined || manifest['module'] !== undefined) {
    if (manifest['type'] !== 'module') errors.push(`${name}: exported libraries must declare type: module`);
    checkExports(manifest['exports'], `${name}.exports`, errors);
    for (const field of ['main', 'module', 'types', 'typings', 'browser']) {
      checkExports(manifest[field], `${name}.${field}`, errors);
    }
  }
  const scripts = manifest['scripts'];
  if (isRecord(scripts)) {
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command === 'string' && commonJsBuild.test(command)) {
        errors.push(`scripts.${name}: first-party CommonJS builds are not supported`);
      }
    }
  }
  const bin = manifest['bin'];
  const paths = typeof bin === 'string' ? [bin] : isRecord(bin) ? Object.values(bin) : [];
  for (const path of paths) {
    if (typeof path === 'string' && commonJsFile.test(path) && !allowedBins.get(name)?.has(path.replace(/^\.\//, ''))) {
      errors.push(`${name}.bin: unapproved CommonJS launcher ${path}`);
    }
  }
  return errors;
}

/** @param {unknown} value @returns {string[]} */
function targets(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(targets);
  return isRecord(value) ? Object.values(value).flatMap(targets) : [];
}

/**
 * Validate npm pack's file inventory, including stale undeclared build output.
 * Third-party require() wrappers inside an ESM bundle are deliberately allowed.
 * @param {Record<string, unknown>} manifest
 * @param {readonly string[]} files
 * @returns {string[]}
 */
export function checkEsmPack(manifest, files) {
  const errors = checkEsmManifest(manifest);
  const name = manifest['name'];
  const allowed = typeof name === 'string' ? allowedBins.get(name) : undefined;
  const declaredBins = new Set(targets(manifest['bin']).map(path => path.replace(/^\.\//, '')));
  const inventory = new Set(files.map(path => path.replace(/^\.\//, '')));
  for (const path of inventory) {
    if (commonJsFile.test(path) && (!allowed?.has(path) || !declaredBins.has(path))) {
      errors.push(`pack: unexpected CommonJS artifact ${path}`);
    }
  }
  for (const field of ['exports', 'main', 'module', 'types', 'typings', 'bin']) {
    for (const target of targets(manifest[field])) {
      const path = target.replace(/^\.\//, '');
      if (path.includes('*')) {
        errors.push(`${field}: wildcard target requires an explicit package acceptance check: ${target}`);
      } else if (!inventory.has(path)) {
        errors.push(`${field}: published target is missing: ${target}`);
      }
    }
  }
  return errors;
}

/** @param {string} [directory] */
export async function checkRepository(directory = root) {
  const errors = [];
  for (const entry of await readdir(resolve(directory, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(directory, 'packages', entry.name, 'package.json');
    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isRecord(error) && error['code'] === 'ENOENT') continue;
      throw error;
    }
    errors.push(...checkEsmManifest(JSON.parse(content)).map(error => `${entry.name}/package.json: ${error}`));
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

/** @param {string} directory */
export async function checkPackedDirectory(directory) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: directory, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'inherit'],
    // Only fixed npm arguments enter the Windows command interpreter.
    shell: process.platform === 'win32',
  });
  const reports = JSON.parse(output);
  if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0]?.files)) {
    throw new Error('npm pack did not return one package file inventory');
  }
  const errors = checkEsmPack(manifest, reports[0].files.map(file => file.path));
  if (errors.length) throw new Error(errors.join('\n'));
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  const args = process.argv.slice(2);
  const work = args.length === 0 ? checkRepository()
    : args.length === 2 && args[0] === '--pack' ? checkPackedDirectory(resolve(args[1]))
    : Promise.reject(new Error('Usage: esm-package-policy.mjs [--pack <package-directory>]'));
  work.then(() => console.log('First-party ESM package policy passed.')).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
