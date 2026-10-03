import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson } from './model.mjs';

export const METADATA_PATH = 'packages/cli/src/shared/tools/starter-metadata.json';
export const TRUST_ROOT_SOURCE = 'packages/management-api/src/assets/sigstore-public-good-trusted-root.jsonl';
export const TRUST_ROOT_OUTPUT = 'packages/delivery/src/assets/sigstore-public-good-trusted-root.jsonl';
export const METADATA_PACKAGES = {
  compilerMetadata: 'compiler', appMetadata: 'app', elysiaMetadata: 'elysia',
  commandsMetadata: 'commands', contractsMetadata: 'contracts', dbMetadata: 'db', sdkMetadata: 'supacloud-js',
};
const stamp = 'supacloud.workspace-sync.v1';
const digest = (text) => text === null ? null : createHash('sha256').update(text).digest('hex');
const readOptional = (path) => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** Refuse symlinked inputs AND parents. A sync never follows an output outside this checkout. */
export function ownedPath(root, file) {
  root = resolve(root);
  const path = resolve(root, file);
  const local = relative(root, path);
  if (!local || local.startsWith('..') || resolve(root, local) !== path) throw new Error(`Unsafe managed path: ${file}`);
  let current = path;
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink in managed path: ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === root) break;
    current = dirname(current);
  }
  return path;
}

/** Deliberately small snapshots: no arbitrary manifest contents, credentials or application code. */
export function derivedFiles(root) {
  const metadata = { _generatedBy: stamp };
  for (const [key, name] of Object.entries(METADATA_PACKAGES)) {
    const manifest = readJson(ownedPath(root, `packages/${name}/package.json`));
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) throw new Error(`Invalid starter version: ${name}`);
    metadata[key] = { version: manifest.version };
    const copy = (field, dependency) => {
      const version = manifest[field]?.[dependency];
      if (typeof version !== 'string' || !version.trim()) throw new Error(`Missing starter dependency: ${name}/${dependency}`);
      metadata[key][field] = { ...metadata[key][field], [dependency]: version };
    };
    if (name === 'app') copy('dependencies', 'rxjs');
    if (name === 'db') { copy('peerDependencies', 'drizzle-orm'); copy('devDependencies', 'drizzle-kit'); }
    if (name === 'supacloud-js') copy('peerDependencies', '@supabase/supabase-js');
  }
  const trustedRoot = readFileSync(ownedPath(root, TRUST_ROOT_SOURCE), 'utf8');
  if (`${JSON.stringify(JSON.parse(trustedRoot))}\n` !== trustedRoot) throw new Error('Trusted root must remain canonical compact JSONL.');
  return [
    { path: METADATA_PATH, content: `${JSON.stringify(metadata, null, 2)}\n`, inputs: Object.values(METADATA_PACKAGES).map((name) => `packages/${name}/package.json`) },
    { path: TRUST_ROOT_OUTPUT, content: trustedRoot, inputs: [TRUST_ROOT_SOURCE] },
  ];
}

function headContent(root, file) {
  try { return execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return null; }
}

export function syncPlan(root) {
  return derivedFiles(root).map((file) => {
    const current = readOptional(ownedPath(root, file.path));
    const status = current === file.content ? 'current' : current === null ? 'create'
      : current === headContent(root, file.path) ? 'update' : 'conflict';
    return { ...file, before: current, status, beforeHash: digest(current), afterHash: digest(file.content) };
  });
}

/** Plan first, validate all conflicts, stage all writes, then compare-and-replace owned files. */
export function applySync(root) {
  const lock = ownedPath(root, '.nx/workspace-sync.lock');
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  const staged = [];
  const written = [];
  try {
    const plan = syncPlan(root);
    const conflicts = plan.filter((file) => file.status === 'conflict');
    if (conflicts.length) throw new Error(`Uncommitted generated edits require reconciliation: ${conflicts.map((f) => f.path).join(', ')}`);
    for (const file of plan.filter((f) => f.status !== 'current')) {
      const path = ownedPath(root, file.path);
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, file.content, { flag: 'wx', mode: 0o644 });
      staged.push({ ...file, temporary });
    }
    const latest = derivedFiles(root);
    if (latest.some((file, index) => file.content !== plan[index].content)) throw new Error('Managed inputs changed during sync; retry after reconciling source edits.');
    for (const file of staged) if (readOptional(ownedPath(root, file.path)) !== file.before) throw new Error(`Concurrent edit: ${file.path}`);
    for (const file of staged) {
      const path = ownedPath(root, file.path);
      if (readOptional(path) !== file.before) throw new Error(`Concurrent edit: ${file.path}`);
      renameSync(file.temporary, path);
      written.push(file);
    }
    return plan;
  } catch (error) {
    const errors = [error];
    for (const file of written.reverse()) {
      try {
        const path = ownedPath(root, file.path);
        if (readOptional(path) !== file.content) throw new Error(`Rollback preserved a concurrent edit: ${file.path}`);
        if (file.before === null) rmSync(path); else writeFileSync(path, file.before);
      } catch (rollback) { errors.push(rollback); }
    }
    throw errors.length === 1 ? error : new AggregateError(errors, 'Sync failed; inspect rollback errors.');
  } finally {
    for (const file of staged) rmSync(file.temporary, { force: true });
    rmSync(lock, { force: true });
  }
}

export function main(args = process.argv.slice(2), root = fileURLToPath(new URL('../../', import.meta.url))) {
  if (args.length > 1 || args.length && !['--check', '--write'].includes(args[0])) throw new Error('Usage: workspace:sync [--check|--write]');
  const plan = args[0] === '--write' ? applySync(root) : syncPlan(root);
  const changed = plan.some((f) => f.status !== 'current');
  console.log(JSON.stringify({ schemaVersion: 1, generator: stamp, mode: args[0] ?? 'preview', changed,
    files: plan.map(({ path, inputs, status, beforeHash, afterHash }) => ({ path, inputs, status, beforeHash, afterHash })) }, null, 2));
  if (args[0] === '--check' && changed) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
