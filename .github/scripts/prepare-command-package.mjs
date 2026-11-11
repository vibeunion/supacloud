import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRecord, packageVersion, stableVersionPrecedence } from './package-validation.mjs';
import { NPM_REGISTRY, waitForRegistryVersion } from './npm-registry-visibility.mjs';
import { appPackageSpecifiers, unmetAppSubpaths } from '../../scripts/check-elysia-compatibility.mjs';

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

/**
 * Read the built adapter. Publication must see the same static imports that
 * ship in dist, including declaration files such as worker.d.ts.
 * @param {string} directory
 */
function readElysiaDist(directory) {
  const dist = resolve(directory, 'dist');
  if (!existsSync(dist)) {
    throw new Error('@supacloud/elysia publication requires dist/ before rewriting @supacloud/app');
  }
  /** @type {string[]} */
  const texts = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:mjs|cjs|js|d\.ts)$/.test(entry.name)) texts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(dist);
  if (texts.length === 0) throw new Error('@supacloud/elysia dist/ has no JavaScript or declaration files');
  return texts.join('\n');
}

/** @param {unknown} stdout @param {string} label */
function parseNpmJson(stdout, label) {
  if (typeof stdout !== 'string' || stdout.trim() === '') throw new Error(`npm returned no ${label}`);
  return JSON.parse(stdout);
}

/**
 * The rewritten dependency is an exact version. Its registry manifest, not the
 * workspace package.json, decides whether that version actually exports the
 * subpath. @supacloud/app@0.39.1 is the case this rejects: the workspace export
 * exists, and the published tarball does not.
 * @param {string} directory
 * @param {Record<string, unknown>} prepared
 * @param {{ runNpm?: (arguments_: string[]) => Promise<{ stdout?: unknown, stderr?: unknown }> }} [options]
 */
export async function assertElysiaAppPublication(directory, prepared, options = {}) {
  const specifiers = appPackageSpecifiers(readElysiaDist(directory));
  const dependencies = prepared['dependencies'];
  const range = isRecord(dependencies) ? dependencies['@supacloud/app'] : undefined;
  if (typeof range !== 'string' || !/^\d+\.\d+\.\d+$/.test(range)) {
    throw new Error(`@supacloud/elysia must publish an exact @supacloud/app version, not ${String(range)}`);
  }
  if (specifiers.length === 0) return;
  const runNpm = options.runNpm ?? ((arguments_) => run('npm', arguments_));
  const spec = `@supacloud/app@${range}`;
  const viewed = await runNpm(['view', spec, 'exports', '--json', `--registry=${NPM_REGISTRY}`]);
  const parsedExports = parseNpmJson(viewed.stdout, `${spec} exports`);
  const exportsMap = isRecord(parsedExports) && Object.prototype.hasOwnProperty.call(parsedExports, '.')
    ? parsedExports
    : isRecord(parsedExports) && isRecord(parsedExports[range]) && Object.prototype.hasOwnProperty.call(parsedExports[range], '.')
      ? parsedExports[range]
      : null;
  if (!isRecord(exportsMap)) throw new Error(`npm returned invalid exports for ${spec}`);
  const packed = await runNpm(['pack', spec, '--dry-run', '--ignore-scripts', '--json', `--registry=${NPM_REGISTRY}`]);
  const reports = parseNpmJson(packed.stdout, `${spec} pack inventory`);
  if (!Array.isArray(reports) || reports.length !== 1 || !isRecord(reports[0]) || !Array.isArray(reports[0]['files'])) {
    throw new Error(`npm pack did not return one file inventory for ${spec}`);
  }
  const files = reports[0]['files'].map((file) => {
    if (!isRecord(file) || typeof file['path'] !== 'string') throw new Error(`npm pack returned an invalid file entry for ${spec}`);
    return file['path'];
  });
  const problems = unmetAppSubpaths(specifiers, exportsMap, files);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to publish @supacloud/elysia against ${spec}.\n${problems.join('\n')}\n`
      + 'Publish a new @supacloud/app version that contains these exports before this adapter.',
    );
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
  if (candidate['name'] === '@supacloud/elysia') await assertElysiaAppPublication(directory, result.package);
  await writeFile(path, `${JSON.stringify(result.package, null, 2)}\n`);
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  prepare().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
