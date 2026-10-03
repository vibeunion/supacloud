import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownedPath } from './sync.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const inherited = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'BUN_INSTALL', 'BUN_INSTALL_CACHE_DIR'];
/** Cached builds receive no caller secrets, NODE_OPTIONS, Nx per-run variables or implicit user flags. */
export function buildEnvironment(env = process.env) {
  return { ...Object.fromEntries(inherited.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]])),
    CI: 'true', NODE_ENV: 'production', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', SOURCE_DATE_EPOCH: '0',
    BUN_CONFIG_NO_CLEAR_TERMINAL: '1' };
}
function dotenvInputs(root, project) {
  return [root, ownedPath(root, project)].flatMap((directory) => readdirSync(directory)
    .filter((name) => /^\.env(?:\.(?:local|production|development|test)(?:\.local)?)?$/.test(name))
    .sort().map((name) => ({ path: resolve(directory, name), bytes: readFileSync(ownedPath(root, `${directory === root ? '' : `${project}/`}${name}`)) })));
}
export function buildContext(project, cwd = root, env = process.env) {
  if (!/^packages\/[a-zA-Z0-9._-]+$/.test(project)) throw new Error('Expected an owned package directory.');
  const environment = buildEnvironment(env);
  const dotenv = dotenvInputs(resolve(cwd), project);
  // Bun may load a user's global config independently of --no-env-file. Fail closed.
  const home = environment.HOME ?? environment.USERPROFILE;
  const globalConfig = home && existsSync(resolve(home, '.bunfig.toml'))
    ? readFileSync(resolve(home, '.bunfig.toml')) : null;
  return { environment, dotenv, globalConfig,
    hash: createHash('sha256').update(JSON.stringify({
      platform: process.platform, architecture: process.arch, node: process.version,
      bun: execFileSync('bun', ['--revision'], { encoding: 'utf8', env: environment }).trim(),
      globalConfig: globalConfig === null ? null : createHash('sha256').update(globalConfig).digest('hex'),
      environment: Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
      dotenv: dotenv.map(({ path, bytes }) => [path, createHash('sha256').update(bytes).digest('hex')]),
    })).digest('hex') };
}
export function main(args = process.argv.slice(2), cwd = root) {
  const hashOnly = args[0] === '--hash';
  if (args.length !== (hashOnly ? 2 : 1)) throw new Error('Usage: build [--hash] packages/NAME');
  const project = args[hashOnly ? 1 : 0];
  const context = buildContext(project, cwd);
  if (hashOnly) { console.log(context.hash); return; }
  // A new ignored dotenv file changes the hash, then fails here rather than replaying stale output.
  if (context.globalConfig !== null) throw new Error('Cached builds require no global .bunfig.toml; use the uncached package build.');
  if (context.dotenv.length) throw new Error('Cached builds do not load dotenv files. Use the uncached package build or remove local dotenv inputs.');
  const result = spawnSync('bun', ['--no-env-file', 'run', 'build'], { cwd: ownedPath(cwd, project), env: context.environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Package build failed: ${result.signal ?? result.status}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
