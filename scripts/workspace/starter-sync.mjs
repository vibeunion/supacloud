import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STARTER_FILE = 'packages/cli/src/shared/tools/starter-metadata.json';
export const STARTER_PACKAGES = Object.freeze({
  compiler: ['compiler', '@supacloud/compiler'], app: ['app', '@supacloud/app'],
  elysia: ['elysia', '@supacloud/elysia'], commands: ['commands', '@supacloud/commands'],
  contracts: ['contracts', '@supacloud/contracts'], db: ['db', '@supacloud/db'],
  sdk: ['supacloud-js', '@supacloud/js'],
});
const generator = 'supacloud/starter-metadata-v1';
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

function regularFile(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Refusing non-regular or multiply linked file: ${path}`);
  return true;
}
function safePath(cwd, file) {
  let current = resolve(cwd);
  for (const part of file.split('/').slice(0, -1)) {
    current = join(current, part);
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error(`Refusing unsafe parent: ${current}`);
  }
  return resolve(cwd, file);
}
function dependency(manifest, section, name) {
  const value = manifest[section]?.[name];
  if (typeof value !== 'string' || !value || /^(?:file:|link:|workspace:)/.test(value)) throw new Error(`Missing publishable ${section}.${name} in ${manifest.name}`);
  return value;
}

/** Only the fields actually embedded by CLI starters; never copy environment or credentials. */
export function starterMetadata(cwd = root) {
  const packages = {};
  for (const [alias, [directory, name]] of Object.entries(STARTER_PACKAGES)) {
    const file = safePath(cwd, `packages/${directory}/package.json`);
    if (!regularFile(file)) throw new Error(`Missing source manifest: ${file}`);
    const manifest = read(file);
    if (manifest.name !== name || !semver.test(manifest.version ?? '')) throw new Error(`Invalid starter source identity/version: ${file}`);
    const entry = { version: manifest.version };
    if (alias === 'app') entry.dependencies = { rxjs: dependency(manifest, 'dependencies', 'rxjs') };
    if (alias === 'db') {
      entry.peerDependencies = { 'drizzle-orm': dependency(manifest, 'peerDependencies', 'drizzle-orm') };
      entry.devDependencies = { 'drizzle-kit': dependency(manifest, 'devDependencies', 'drizzle-kit') };
    }
    if (alias === 'sdk') entry.peerDependencies = { '@supabase/supabase-js': dependency(manifest, 'peerDependencies', '@supabase/supabase-js') };
    packages[alias] = entry;
  }
  return { schemaVersion: 1, generatedBy: generator, packages };
}

export function planStarterSync(cwd = root) {
  const file = safePath(cwd, STARTER_FILE);
  const before = regularFile(file) ? readFileSync(file, 'utf8') : null;
  if (before !== null) {
    const existing = JSON.parse(before);
    if (existing.schemaVersion !== 1 || existing.generatedBy !== generator ||
        Object.keys(existing).some((key) => !['schemaVersion', 'generatedBy', 'packages'].includes(key))) {
      throw new Error('Existing starter metadata is not owned by this generator; it will not be overwritten.');
    }
  }
  const desired = starterMetadata(cwd);
  // Never discard custom fields at any depth, even inside a generator-owned file.
  const checkShape = (current, expected) => {
    if (expected && typeof expected === 'object') {
      if (!current || typeof current !== 'object' || Array.isArray(current) ||
          Object.keys(current).length !== Object.keys(expected).length ||
          Object.keys(current).some((key) => !Object.hasOwn(expected, key))) {
        throw new Error('Existing starter metadata has unowned or missing fields; it will not be overwritten.');
      }
      for (const key of Object.keys(expected)) checkShape(current[key], expected[key]);
    } else if (typeof current !== typeof expected) {
      throw new Error('Existing starter metadata has an invalid owned field type.');
    }
  };
  if (before !== null) checkShape(JSON.parse(before), desired);
  const after = json(desired);
  const beforeHash = before === null ? null : hash(before);
  const afterHash = hash(after);
  const changed = before !== after;
  const planHash = hash(JSON.stringify({ file: STARTER_FILE, beforeHash, afterHash }));
  return { schemaVersion: 1, file: STARTER_FILE, changed, beforeHash, afterHash, planHash,
    changes: changed ? [{ before: before === null ? null : JSON.parse(before), after: JSON.parse(after) }] : [] };
}

/** Single owned-file transaction. A preview token binds both the destination and fresh source versions. */
export function applyStarterSync(expectedPlanHash, cwd = root) {
  if (!/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '')) throw new Error('Applying requires --expect <planHash> from a reviewed preview.');
  const file = safePath(cwd, STARTER_FILE);
  const lock = `${file}.sync-lock`;
  const fd = openSync(lock, 'wx', 0o600);
  const temporary = join(dirname(file), `.starter-metadata-${randomUUID()}.tmp`);
  try {
    let plan = planStarterSync(cwd);
    if (plan.planHash !== expectedPlanHash) throw new Error('Sync conflict: source or destination changed since preview.');
    if (!plan.changed) return plan;
    const content = json(starterMetadata(cwd));
    if (hash(content) !== plan.afterHash) throw new Error('Sync conflict: source changed during planning.');
    const output = openSync(temporary, 'wx', 0o644);
    try { writeFileSync(output, content); fsyncSync(output); } finally { closeSync(output); }
    safePath(cwd, STARTER_FILE);
    plan = planStarterSync(cwd);
    if (plan.planHash !== expectedPlanHash) throw new Error('Sync conflict: source or destination changed before commit.');
    renameSync(temporary, file);
    return { ...plan, applied: true };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(fd);
    unlinkSync(lock);
  }
}

export function checkStarterReleaseConfig(cwd = root) {
  const config = read(resolve(cwd, 'release-please-config.json'));
  for (const [alias, [directory]] of Object.entries(STARTER_PACKAGES)) {
    const updates = config.packages?.[`packages/${directory}`]?.['extra-files'] ?? [];
    if (!updates.some((entry) => entry.type === 'json' && entry.path === `/${STARTER_FILE}` && entry.jsonpath === `$.packages.${alias}.version`)) {
      throw new Error(`Release configuration must synchronize the starter version for ${directory}.`);
    }
  }
}

export function main(args = process.argv.slice(2), cwd = root) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--check')) {
    const plan = planStarterSync(cwd);
    console.log(JSON.stringify(plan, null, 2));
    if (args[0] === '--check') {
      checkStarterReleaseConfig(cwd);
      if (plan.changed) throw new Error('Starter metadata is out of sync. Review workspace:sync, then apply its exact plan hash.');
    }
    return;
  }
  if (args.length === 3 && args[0] === '--apply' && args[1] === '--expect') {
    console.log(JSON.stringify(applyStarterSync(args[2], cwd), null, 2));
    return;
  }
  throw new Error('Usage: workspace:sync [--check | --apply --expect PLAN_HASH]');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
