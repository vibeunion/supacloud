import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const digest = (text) => createHash('sha256').update(text).digest('hex');
const missing = (error) => error?.code === 'ENOENT';

/** Only the adapter's explicit output registry can be written, never paths from a plan. */
function ownedFile(root, file, registry) {
  if (!registry.includes(file)) throw new Error(`Unowned sync output: ${file}`);
  const path = resolve(root, file);
  const local = relative(root, path);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('Sync output escapes its root.');
  for (let part = path; part !== resolve(root); part = dirname(part)) {
    try { if (lstatSync(part).isSymbolicLink()) throw new Error(`Symlink in sync output path: ${file}`); }
    catch (error) { if (!missing(error)) throw error; }
  }
  try { if (!lstatSync(path).isFile()) throw new Error(`Sync output is not a regular file: ${file}`); }
  catch (error) { if (!missing(error)) throw error; }
  return path;
}
function readOptional(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
}
const hashOptional = (text) => text === null ? null : digest(text);

/** A plan contains no executable code or arbitrary new file contents. */
export function syncPlan(root, outputs) {
  const registry = outputs.map((output) => output.file);
  if (new Set(registry).size !== registry.length) throw new Error('Duplicate sync output.');
  const changes = outputs.map(({ file, content, summary = [] }) => {
    if (typeof content !== 'string') throw new Error('Generator must return UTF-8 text.');
    const before = readOptional(ownedFile(root, file, registry));
    return { file, before: hashOptional(before), after: digest(content), changed: before !== content, summary };
  });
  return { schemaVersion: 1, kind: 'supacloud-reviewed-sync', clean: changes.every((change) => !change.changed), changes };
}

/**
 * Recompute from trusted generators before applying; reject edited inputs/outputs.
 * Atomic per-file replace, with guarded best-effort rollback on ordinary I/O failure.
 * This is not a filesystem transaction across process crashes or external writers.
 */
export function applySyncPlan(root, plan, outputs, { replace = renameSync } = {}) {
  if (plan?.schemaVersion !== 1 || plan.kind !== 'supacloud-reviewed-sync' || !Array.isArray(plan.changes)) throw new Error('Invalid sync plan.');
  const fresh = syncPlan(root, outputs);
  const identity = (entry) => ({ file: entry.file, before: entry.before, after: entry.after, changed: entry.changed });
  if (JSON.stringify(plan.changes.map(identity)) !== JSON.stringify(fresh.changes.map(identity))) throw new Error('Stale sync plan: generated inputs or destination files changed; review a new plan.');
  const registry = outputs.map((output) => output.file);
  const staged = [], applied = [];
  try {
    for (const output of outputs) {
      const change = fresh.changes.find((entry) => entry.file === output.file);
      if (!change.changed) continue;
      const path = ownedFile(root, output.file, registry);
      const before = readOptional(path);
      if (hashOptional(before) !== change.before) throw new Error(`Concurrent edit to ${output.file}; refusing to stage.`);
      const temporary = `${path}.sync-${randomUUID()}.tmp`;
      const mode = before === null ? 0o644 : lstatSync(path).mode & 0o777;
      const fd = openSync(temporary, 'wx', mode);
      staged.push({ path, file: output.file, temporary, before, after: output.content });
      try { writeFileSync(fd, output.content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    }
    for (const item of staged) {
      ownedFile(root, item.file, registry);
      if (readOptional(item.path) !== item.before) throw new Error(`Concurrent edit to ${item.file}; refusing to overwrite.`);
      replace(item.temporary, item.path);
      applied.push(item);
    }
  } catch (error) {
    const conflicts = [];
    for (const item of applied.reverse()) {
      try {
        ownedFile(root, item.file, registry);
        if (readOptional(item.path) !== item.after) { conflicts.push(item.file); continue; }
        if (item.before === null) unlinkSync(item.path);
        else {
          writeFileSync(item.temporary, item.before, { flag: 'wx', mode: lstatSync(item.path).mode & 0o777 });
          renameSync(item.temporary, item.path);
        }
      } catch { conflicts.push(item.file); }
    }
    throw new Error(`${error.message}${conflicts.length ? `; rollback requires inspection: ${conflicts.join(', ')}` : ''}`);
  } finally {
    for (const item of staged) { try { unlinkSync(item.temporary); } catch (error) { if (!missing(error)) throw error; } }
  }
  return { ...syncPlan(root, outputs), applied: staged.map((item) => item.file) };
}
