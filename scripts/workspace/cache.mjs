import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Only this audited browser contract build is enabled. Tests, installs, packaging,
// network verification, deployment and user-defined commands remain uncached.
export const CONTRACT_RECIPE = '2817613624c7df51576ff90a76054afcbfffc8dc2b29c954406be9214f2f01f2';
export function recipeHash(manifest) {
  const recipe = { scripts: manifest.scripts, dependencies: manifest.dependencies ?? {},
    devDependencies: manifest.devDependencies ?? {}, peerDependencies: manifest.peerDependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {} };
  return createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
}
export function cacheEligible(project) {
  return project.name === '@supacloud/contracts' && project.root === 'packages/contracts' &&
    recipeHash(project.manifest) === CONTRACT_RECIPE;
}

/** Also hashes ignored/untracked package inputs that Nx filesets might not see. */
export function cacheFingerprint(root, environment = process.env, versions) {
  const directory = resolve(root, 'packages/contracts');
  for (const path of [root, resolve(root, 'packages'), directory]) {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Cache input root must not be a symlink.');
    if (readdirSync(path).some((name) => /^\.env(?:$|\.)/.test(name) && name !== '.env.example')) {
      throw new Error('Cached contracts builds forbid dotenv inputs. Use the direct Bun build for an environment-specific build.');
    }
  }
  const checkOutput = (path) => {
    let info;
    try { info = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error('Cache output must not be a symlink.');
    if (info.isDirectory()) for (const name of readdirSync(path)) checkOutput(resolve(path, name));
  };
  checkOutput(resolve(directory, 'dist'));
  const hash = createHash('sha256');
  const visit = (path, prefix = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && ['node_modules', 'dist', '.git', '.nx'].includes(entry.name)) continue;
      if (prefix && entry.name === 'node_modules') throw new Error('Nested dependency roots are not supported by the contracts cache.');
      if (entry.isSymbolicLink()) throw new Error(`Unsupported symlink cache input: ${prefix}${entry.name}`);
      if (entry.isDirectory()) visit(resolve(path, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) {
        const bytes = readFileSync(resolve(path, entry.name));
        hash.update(`${prefix}${entry.name}\0${bytes.length}\0`).update(bytes);
      } else throw new Error('Unsupported non-file cache input.');
    }
  };
  visit(directory);
  const flags = Object.fromEntries(Object.entries(environment).filter(([name]) =>
    /^(NODE_|BUN_|TS_|LC_)/.test(name) || ['TZ', 'LANG', 'SOURCE_DATE_EPOCH', 'CI'].includes(name)).sort(([a], [b]) => a.localeCompare(b)));
  const toolchain = versions ?? { node: process.version,
    bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(), platform: process.platform, arch: process.arch };
  return hash.update(JSON.stringify({ flags, toolchain })).digest('hex');
}

export function cachedBuildOptions(project) {
  if (!cacheEligible(project)) return {};
  return {
    cache: true,
    inputs: [
      // Deliberately conservative: include repository source rather than trusting
      // the manifest-only affected graph to prove the entire build input closure.
      '{workspaceRoot}/**/*', '!{workspaceRoot}/**/node_modules/**/*',
      '!{workspaceRoot}/packages/*/dist/**/*', '!{workspaceRoot}/.nx/**/*',
      { runtime: 'node scripts/workspace/cache.mjs' },
    ],
    outputs: ['{projectRoot}/dist'],
    metadata: { description: 'Verified local contracts build cache; recipe changes revoke eligibility. Full CI remains required.' },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(cacheFingerprint(fileURLToPath(new URL('../../', import.meta.url)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
