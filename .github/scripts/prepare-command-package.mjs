import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRecord, packageVersion, stableVersionPrecedence } from './package-validation.mjs';

const root = fileURLToPath(new URL('../../packages/', import.meta.url));
const run = promisify(execFile);
const directories = ['contracts', 'commands', 'db', 'app', 'app-svelte', 'compiler', 'elysia', 'supacloud-js'];
/** @param {string} directory */
const packageName = (directory) => directory === 'supacloud-js' ? '@supacloud/js' : `@supacloud/${directory}`;

/**
 * Resolve development-only sibling references before packing. Exact versions
 * ensure consumers share the protocol error class. Build-only dependencies do
 * not become runtime dependencies or block on registry availability.
 * @param {unknown} candidate
 * @param {ReadonlyMap<string, unknown>} siblings
 */
export function prepareCommandPackage(candidate, siblings) {
  if (!isRecord(candidate) || typeof candidate['name'] !== 'string') throw new Error('Invalid package manifest');
  const next = structuredClone(candidate);
  /** @type {Set<string>} */
  const required = new Set();
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies', 'overrides']) {
    const entries = next[section];
    if (entries === undefined) continue;
    if (!isRecord(entries)) throw new Error(`Invalid ${section}`);
    for (const [name, range] of Object.entries(entries)) {
      if (typeof range !== 'string') throw new Error(`Invalid ${section}.${name}`);
      if (!/^(file:|link:|workspace:)/.test(range)) continue;
      const sibling = siblings.get(name);
      if (!isRecord(sibling) || sibling['name'] !== name || range !== `file:../${name.replace('@supacloud/', '')}`) {
        throw new Error(`Unrecognized local dependency ${name}`);
      }
      const version = packageVersion(sibling, name);
      stableVersionPrecedence(version, name);
      entries[name] = version;
      if (section !== 'devDependencies') required.add(`${name}@${version}`);
    }
  }
  return { package: next, required: [...required].sort() };
}

/** @param {string} path @returns {Promise<unknown>} */
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

/** One registry read per dependency. Failure leaves the manifest untouched. */
async function prepare(directory = process.cwd()) {
  const path = resolve(directory, 'package.json');
  const candidate = await readJson(path);
  if (!isRecord(candidate) || !directories.some((name) => candidate['name'] === packageName(name))) {
    throw new Error('Not a managed command package');
  }
  /** @type {Map<string, unknown>} */
  const siblings = new Map();
  for (const name of directories) siblings.set(packageName(name), await readJson(resolve(root, name, 'package.json')));
  const result = prepareCommandPackage(candidate, siblings);
  for (const spec of result.required) {
    const { stdout } = await run('npm', ['view', spec, 'version', '--json', '--registry=https://registry.npmjs.org']);
    /** @type {unknown} */
    const published = JSON.parse(stdout);
    if (typeof published !== 'string' || !spec.endsWith(`@${published}`)) {
      throw new Error(`Dependency is not published: ${spec}`);
    }
  }
  await writeFile(path, `${JSON.stringify(result.package, null, 2)}\n`);
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  prepare().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
