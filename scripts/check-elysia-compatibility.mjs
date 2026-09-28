import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const frameworkPackages = new Set(['@supacloud/app', '@supacloud/compiler']);
const templatePaths = [
  'packages/cli/src/shared/tools/advanced-tools.ts',
  'packages/cli/src/shared/tools/app-starter.ts',
  'packages/cli/src/shared/tools/app-starter-templates.ts',
  'packages/compiler/src/migration-policy.ts',
];

/** Parse Bun's emitted JSON-with-trailing-commas without evaluating repository code. */
export function parseLockfile(source) {
  return JSON.parse(source.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g,
    (token) => token.startsWith(',') ? '' : token));
}

/** Check repository-owned declarations, not third-party or isolated user dependencies. */
export function checkElysiaCompatibility(root) {
  const problems = [];
  const readJSON = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const matrix = readJSON('packages/elysia/compatibility.json');
  const expected = matrix.packages?.elysia;
  if (typeof expected !== 'string' || !/^2\.0\.0-beta\.\d+$/.test(expected)) {
    return ['compatibility.json must declare an exact Elysia 2.0 beta version'];
  }
  for (const name of ['typebox', 'exact-mirror']) {
    if (typeof matrix.packages?.[name] !== 'string' || !/^\d+\.\d+\.\d+$/.test(matrix.packages[name])) {
      problems.push(`compatibility.json must declare the active ${name} version`);
    }
  }
  for (const directory of ['app', 'compiler', 'elysia']) {
    if (!existsSync(resolve(root, `packages/${directory}/package.json`))) {
      problems.push(`packages/${directory}/package.json: missing required framework manifest`);
    }
  }
  const directories = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`);
  for (const directory of ['.', ...directories]) {
    const manifestPath = `${directory}/package.json`;
    if (!existsSync(resolve(root, manifestPath))) continue;
    const manifest = readJSON(manifestPath);
    const declared = sections.filter((section) => manifest[section]?.elysia !== undefined);
    for (const section of sections) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        if (frameworkPackages.has(manifest.name)
          && (/^(?:elysia(?:\/|$)|@elysia(?:js)?\/|@supacloud\/elysia$)/.test(name)
            || /^npm:(?:elysia@|@elysia(?:js)?\/|@supacloud\/elysia@)/.test(String(spec)))) {
          problems.push(`${manifestPath}: ${section}.${name} couples the application/compiler package to Elysia`);
        }
      }
      if (manifest[section]?.elysia !== undefined && manifest[section].elysia !== expected) {
        problems.push(`${manifestPath}: ${section}.elysia must equal ${expected}`);
      }
    }
    if (['@supacloud/app', '@supacloud/compiler', '@supacloud/elysia'].includes(manifest.name)) {
      if (manifest.dependencies?.typebox !== matrix.packages.typebox) {
        problems.push(`${manifestPath}: active typebox dependency must match compatibility.json`);
      }
    }
    if (manifest.name === '@supacloud/elysia') {
      if (manifest.peerDependencies?.elysia !== expected || manifest.devDependencies?.elysia !== expected) {
        problems.push(`${manifestPath}: both peer and development Elysia dependencies must be pinned`);
      }
      if (manifest.dependencies?.['exact-mirror'] !== matrix.packages['exact-mirror']) {
        problems.push(`${manifestPath}: exact-mirror must match compatibility.json`);
      }
    }
    const lockPath = `${directory}/bun.lock`;
    if (!existsSync(resolve(root, lockPath))) {
      if (declared.length) problems.push(`${lockPath}: missing lockfile for a direct Elysia consumer`);
      continue;
    }
    const lock = parseLockfile(readFileSync(resolve(root, lockPath), 'utf8'));
    for (const section of declared) {
      if (lock.workspaces?.['']?.[section]?.elysia !== expected) {
        problems.push(`${lockPath}: stale workspace ${section}.elysia`);
      }
    }
    if (declared.length && lock.packages?.elysia?.[0] !== `elysia@${expected}`) {
      problems.push(`${lockPath}: resolved Elysia version must equal ${expected}`);
    }
    if (manifest.name === '@supacloud/elysia') {
      for (const [name, version] of Object.entries(matrix.packages)) {
        if (lock.packages?.[name]?.[0] !== `${name}@${version}`) {
          problems.push(`${lockPath}: resolved ${name} must match compatibility.json`);
        }
      }
    }
    for (const entry of Object.values(lock.packages ?? {})) {
      // Bun can preserve populated file: snapshots across a frozen install.
      // Empty entries are Bun deduplication placeholders, not full manifests.
      if (['packages/elysia', 'packages/supacloud-lite'].includes(directory)
        && Array.isArray(entry) && typeof entry[0] === 'string'
        && /^@supacloud\/(?:app|compiler|delivery)@file:/.test(entry[0])
        && entry[1] && Object.keys(entry[1]).length > 0
        && (entry[1].dependencies?.typebox !== matrix.packages.typebox
          || entry[1].dependencies?.['@sinclair/typebox'] !== undefined)) {
        problems.push(`${lockPath}: stale local schema metadata for ${entry[0]}`);
      }
      if (Array.isArray(entry) && typeof entry[0] === 'string'
        && entry[0].startsWith('@supacloud/elysia@file:')
        && entry[1]?.peerDependencies?.elysia !== expected) {
        problems.push(`${lockPath}: stale local @supacloud/elysia peer metadata`);
      }
    }
  }
  for (const path of templatePaths) {
    const source = readFileSync(resolve(root, path), 'utf8');
    const matches = [...source.matchAll(/\belysia\s*:\s*["']([^"']+)["']/g)];
    if (!matches.length || matches.some((match) => match[1] !== expected)) {
      problems.push(`${path}: generated/accepted Elysia version must equal ${expected}`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const problems = checkElysiaCompatibility(root);
    if (problems.length) throw new Error(problems.join('\n'));
    console.log('Elysia compatibility declarations and lock metadata are consistent. Runtime acceptance is a separate gate.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
