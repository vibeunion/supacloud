import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRecord, packageVersion, stableVersionPrecedence } from './package-validation.mjs';
import { waitForRegistryVersion } from './npm-registry-visibility.mjs';

export { isNpmNotFoundError } from './npm-registry-visibility.mjs';

const root = fileURLToPath(new URL('../../packages/', import.meta.url));
const run = promisify(execFile);
const directories = ['cli', 'admin', 'contracts', 'commands', 'db', 'db-zenstack', 'app', 'app-svelte', 'delivery', 'compiler', 'elysia', 'query', 'supacloud-js', 'supacloud-lite'];
/** @param {string} directory */
const packageName = (directory) => directory === 'supacloud-js' ? '@supacloud/js' : directory === 'supacloud-lite' ? '@supacloud/lite' : `@supacloud/${directory}`;

/**
 * Resolve development-only sibling references before packing. Exact versions
 * ensure consumers share the protocol error class. Build-only dependencies do
 * not become runtime dependencies or block on registry availability.
 * @param {unknown} candidate
 * @param {ReadonlyMap<string, unknown>} siblings
 * @returns {{ package: Record<string, unknown>; required: string[] }}
 */
export function prepareCommandPackage(candidate, siblings) {
  if (!isRecord(candidate) || typeof candidate['name'] !== 'string') throw new Error('Invalid package manifest');
  const next = structuredClone(candidate);
  /** @type {Set<string>} */
  const required = new Set();
  /** @type {Map<string, string>} */
  const directSpecs = new Map();
  /** @param {string} section */
  const resolveSection = (section) => {
    const entries = next[section];
    if (entries === undefined) return;
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
      // npm requires an override to exactly match a direct dependency spec.
      // Keep ranges such as ^0.57.0 aligned while local direct dependencies
      // have already been normalized to their published exact version.
      entries[name] = section === 'overrides' && directSpecs.has(name)
        ? directSpecs.get(name) : version;
      // Overrides only affect the root install, not consumers of this package.
      if (section !== 'devDependencies' && section !== 'overrides') required.add(`${name}@${version}`);
    }
  };
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    resolveSection(section);
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const entries = next[section];
    if (isRecord(entries)) {
      for (const [name, range] of Object.entries(entries)) {
        if (typeof range === 'string') directSpecs.set(name, range);
      }
    }
  }
  resolveSection('overrides');
  return { package: next, required: [...required].sort() };
}

/** @param {string} path @returns {Promise<unknown>} */
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

/**
 * npm view can 404 for a version that this job just published. Retry those
 * reads so a later package in the same graph is not skipped.
 * @param {readonly string[]} required
 * @param {{
 *   runNpm?: (arguments_: string[]) => Promise<{ stdout?: unknown, stderr?: unknown }>,
 *   sleep?: (ms: number) => Promise<void>,
 *   delays?: readonly number[],
 * }} [options]
 */
export async function assertPublishedDependencies(required, options = {}) {
  const runNpm = options.runNpm ?? ((arguments_) => run('npm', arguments_));
  for (const spec of required) {
    const separator = spec.lastIndexOf('@');
    const version = separator > 0 ? spec.slice(separator + 1) : '';
    if (version.length === 0) throw new Error(`Invalid dependency spec: ${spec}`);
    await waitForRegistryVersion(spec, version, runNpm, options);
  }
}

/** Registry reads retry on a just-published 404. Failure leaves the manifest untouched. */
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
  await assertPublishedDependencies(result.required);
  await writeFile(path, `${JSON.stringify(result.package, null, 2)}\n`);
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  prepare().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
