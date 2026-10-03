import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readWorkspace, resolveProject } from './model.mjs';
import { runNx } from './nx.mjs';

export function prepareVerification(root, alias) {
  const project = resolveProject(readWorkspace(root), alias);
  // The compatibility helper may run before any root dependency install. Frozen
  // tooling bootstrap does not modify package manifests or run install scripts.
  const install = spawnSync('bun', ['install', '--ignore-scripts', '--frozen-lockfile'], { cwd: root, stdio: 'inherit' });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error('Frozen repository tooling installation failed.');
  runNx(['run', `${project.name}:repo-verify-prepare`, '--outputStyle=static'], root);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected exactly one verification consumer name.');
    prepareVerification(fileURLToPath(new URL('../../', import.meta.url)), process.argv[2]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
