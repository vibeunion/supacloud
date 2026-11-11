import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
/** @param {string} source */
export function parseLockfile(source) {
  return JSON.parse(source.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g,
    /** @param {string} token */
    (token) => token.startsWith(',') ? '' : token));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Static `@supacloud/app` and `@supacloud/app/*` imports.
 * Literal specifiers only; a computed import is invisible to this scan.
 * @param {string} source
 * @returns {string[]}
 */
export function appPackageSpecifiers(source) {
  /** @type {Set<string>} */
  const found = new Set();
  const patterns = [
    /(?:^|[^\w$])(?:import|export)\s*(?:type\s+)?[^"'`;]{0,4000}?\sfrom\s*["'](@supacloud\/app(?:\/[^"'\\\r\n]*)?)["']/g,
    /(?:^|[^\w$])import\s*["'](@supacloud\/app(?:\/[^"'\\\r\n]*)?)["']/g,
    /(?:^|[^\w$])import\s*\(\s*["'](@supacloud\/app(?:\/[^"'\\\r\n]*)?)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}

/** @param {string} specifier */
export function appExportSubpath(specifier) {
  if (specifier === '@supacloud/app') return '.';
  if (specifier.startsWith('@supacloud/app/')) return `.${specifier.slice('@supacloud/app'.length)}`;
  return null;
}

/**
 * @param {unknown} entry
 * @param {boolean} typesOnly
 * @returns {string[]}
 */
function conditionalTargets(entry, typesOnly) {
  /** @type {string[]} */
  const targets = [];
  /** @param {unknown} value @param {boolean} inTypes */
  const visit = (value, inTypes) => {
    if (typeof value === 'string') {
      const wanted = typesOnly
        ? inTypes && value.startsWith('./') && value.endsWith('.d.ts')
        : !inTypes && value.startsWith('./') && value.endsWith('.js');
      if (wanted) targets.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inTypes);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) visit(child, inTypes || key === 'types');
  };
  visit(entry, false);
  return [...new Set(targets)];
}

/**
 * Compare static app imports with an export map.
 * When `files` is set, every runtime and declaration target must be in that tarball inventory.
 * @param {readonly string[]} specifiers
 * @param {unknown} exportsMap
 * @param {readonly string[] | undefined} [files]
 * @returns {string[]}
 */
export function unmetAppSubpaths(specifiers, exportsMap, files) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Set<string> | undefined} */
  const inventory = files === undefined ? undefined : new Set(files.map((file) => file.replace(/^\.\//, '').replace(/^package\//, '')));
  for (const specifier of [...specifiers].sort()) {
    const subpath = appExportSubpath(specifier);
    if (!subpath || !isRecord(exportsMap) || exportsMap[subpath] === undefined) {
      problems.push(`static import ${specifier} is not an export (${subpath ?? 'unrecognized specifier'})`);
      continue;
    }
    const runtime = conditionalTargets(exportsMap[subpath], false);
    if (runtime.length === 0) {
      problems.push(`static import ${specifier} export ${subpath} has no runtime JavaScript target`);
      continue;
    }
    if (inventory) {
      for (const target of runtime) {
        if (!inventory.has(target.replace(/^\.\//, ''))) {
          problems.push(`static import ${specifier} runtime file ${target} is not in the published tarball`);
        }
      }
      for (const target of conditionalTargets(exportsMap[subpath], true)) {
        if (!inventory.has(target.replace(/^\.\//, ''))) {
          problems.push(`static import ${specifier} type file ${target} is not in the published tarball`);
        }
      }
    }
  }
  return problems;
}

/** @param {string} directory @param {string[]} files */
function shippingTypeScript(directory, files = []) {
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) shippingTypeScript(path, files);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** Shipping adapter source must stay within the workspace app export map. Test files are excluded. */
/** @param {string} root */
export function checkAdapterAppImports(root) {
  const manifestPath = resolve(root, 'packages/app/package.json');
  if (!existsSync(manifestPath)) return [];
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const exportsMap = isRecord(manifest) ? manifest['exports'] : undefined;
  /** @type {string[]} */
  const problems = [];
  for (const file of shippingTypeScript(resolve(root, 'packages/elysia/src'))) {
    const relative = file.slice(resolve(root).length + 1);
    for (const problem of unmetAppSubpaths(appPackageSpecifiers(readFileSync(file, 'utf8')), exportsMap)) {
      problems.push(`${relative}: ${problem}`);
    }
  }
  return problems;
}

/** Check repository-owned declarations, not third-party or isolated user dependencies. */
/** @param {string} root */
export function checkElysiaCompatibility(root) {
  const problems = [];
  /** @param {string} path */
  const readJSON = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const matrix = readJSON('packages/elysia/compatibility.json');
  const expected = matrix.packages?.elysia;
  if (typeof expected !== 'string' || !/^2\.0\.0-(?:beta|rc)\.\d+$/.test(expected)) {
    return ['compatibility.json must declare an exact Elysia 2.0 prerelease version'];
  }
  for (const name of ['effect', 'typebox', 'exact-mirror']) {
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
    const effectDeclared = sections.filter((section) => manifest[section]?.effect !== undefined);
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
      if (manifest[section]?.effect !== undefined && manifest[section].effect !== matrix.packages.effect) {
        problems.push(`${manifestPath}: ${section}.effect must equal ${matrix.packages.effect}`);
      }
    }
    // Every repository-owned Elysia consumer, plus the framework packages that
    // emit TypeBox schemas, must pin the active schema version so a mixed graph
    // cannot resolve two copies of the same schema runtime.
    if (declared.length || ['@supacloud/app', '@supacloud/compiler'].includes(manifest.name)) {
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
      if (declared.length || effectDeclared.length) {
        problems.push(`${lockPath}: missing lockfile for a direct Elysia or Effect consumer`);
      }
      continue;
    }
    const lock = parseLockfile(readFileSync(resolve(root, lockPath), 'utf8'));
    for (const section of declared) {
      if (lock.workspaces?.['']?.[section]?.elysia !== expected) {
        problems.push(`${lockPath}: stale workspace ${section}.elysia`);
      }
    }
    for (const section of effectDeclared) {
      if (lock.workspaces?.['']?.[section]?.effect !== matrix.packages.effect) {
        problems.push(`${lockPath}: stale workspace ${section}.effect`);
      }
    }
    if (declared.length && lock.packages?.elysia?.[0] !== `elysia@${expected}`) {
      problems.push(`${lockPath}: resolved Elysia version must equal ${expected}`);
    }
    if (effectDeclared.length && lock.packages?.effect?.[0] !== `effect@${matrix.packages.effect}`) {
      problems.push(`${lockPath}: resolved Effect version must match compatibility.json`);
    }
    if (declared.length && lock.packages?.typebox?.[0] !== `typebox@${matrix.packages.typebox}`) {
      problems.push(`${lockPath}: resolved typebox must match compatibility.json`);
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
        && entry[1] && Object.keys(entry[1]).length > 0
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
  problems.push(...checkAdapterAppImports(root));
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
