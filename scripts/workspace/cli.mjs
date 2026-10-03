import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { affectedReport, graphReport, readWorkspace, resolveProject } from './model.mjs';

import { runNx } from './nx.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const split = (value) => value.split('\0').filter(Boolean);
export function changedInputs(cwd, base, head = 'HEAD') {
  if (!base) return { files: [], fallbackReason: 'No explicit successful CI baseline was supplied.' };
  try {
    const commit = (ref) => git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
    const headSha = commit(head);
    if (headSha !== commit('HEAD')) return { files: [], fallbackReason: 'Requested head does not match the checked-out graph.' };
    const baseSha = commit(base);
    const files = split(git(cwd, ['diff', '--no-renames', '--name-only', '-z', baseSha, headSha, '--']));
    // Include staged/unstaged deletions, renamed paths, and new local inputs.
    files.push(...split(git(cwd, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'])));
    files.push(...split(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])));
    return { files: [...new Set(files)].sort() };
  } catch {
    return { files: [], fallbackReason: 'Git baseline/history could not be resolved; full validation is required.' };
  }
}

export function parseArgs(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!['--base', '--head', '--project'].includes(flag) || !rest[index + 1] || rest[index + 1].startsWith('--') || flag in options) {
      throw new Error(`Invalid or duplicate argument: ${flag}`);
    }
    options[flag] = rest[index + 1];
  }
  const allowed = { check: [], graph: [], affected: ['--base', '--head'], build: ['--project'] };
  if (!Object.hasOwn(allowed, command) || Object.keys(options).some((key) => !allowed[command].includes(key))) {
    throw new Error('Usage: workspace <check|graph|affected [--base REF] [--head REF]|build --project NAME>');
  }
  return { command, options };
}

export function main(args = process.argv.slice(2), cwd = root) {
  const { command, options } = parseArgs(args);
  const workspace = readWorkspace(cwd);
  if (command === 'build') {
    const project = resolveProject(workspace, options['--project']);
    if (typeof project.scripts.build !== 'string') throw new Error(`No build script: ${project.name}`);
    runNx(['run', `${project.name}:repo-build`, '--outputStyle=static'], cwd);
    return;
  }
  let report = graphReport(workspace);
  if (command === 'affected') {
    const { files, fallbackReason } = changedInputs(cwd, options['--base'], options['--head']);
    report = affectedReport(workspace, files, fallbackReason);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
