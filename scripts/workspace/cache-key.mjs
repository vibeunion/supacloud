import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Include ignored configuration and effective environment without printing their contents. */
export function cacheContext(root, project, env = process.env, versions = {}) {
  if (project !== 'packages/contracts') throw new Error('No reviewed cache policy for this project.');
  const directories = new Set([resolve(root), resolve(root, 'packages'), resolve(root, project), env.HOME ?? homedir()]);
  if (env.XDG_CONFIG_HOME) directories.add(resolve(env.XDG_CONFIG_HOME));
  // Bun may read user configuration outside the repository; fail rather than omit unreadable inputs.
  for (let parent = dirname(resolve(root)); ; parent = dirname(parent)) {
    directories.add(parent);
    if (parent === dirname(parent)) break;
  }
  const configs = [];
  for (const directory of [...directories].sort()) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).sort()) {
      if (!/^\.env(?:\.|$)/.test(name) && !['bunfig.toml', '.bunfig.toml', '.nxignore', '.gitignore'].includes(name)) continue;
      const file = join(directory, name);
      const stat = lstatSync(file);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported build configuration: ${file}`);
      configs.push([file, createHash('sha256').update(readFileSync(file)).digest('hex')]);
    }
  }
  const effectiveEnv = Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({ platform: process.platform, arch: process.arch,
    node: process.version, versions, effectiveEnv, configs })).digest('hex');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: cache-key.mjs packages/contracts');
    const bun = execFileSync('bun', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    console.log(cacheContext(process.cwd(), process.argv[2], process.env, { bun }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
