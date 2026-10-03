import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Use the installed package's public bin metadata, not Nx's internal layout. */
export function nxExecutable(cwd = root) {
  const require = createRequire(pathToFileURL(resolve(cwd, 'package.json')));
  let manifestPath;
  try { manifestPath = require.resolve('nx/package.json'); }
  catch { throw new Error('Repository Nx is not installed. Run bun install --frozen-lockfile at the repository root.'); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.nx;
  if (typeof bin !== 'string') throw new Error('Installed Nx does not declare an nx executable.');
  const packageRoot = dirname(manifestPath);
  const executable = resolve(packageRoot, bin);
  const local = relative(packageRoot, executable);
  if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\') || !existsSync(executable)) {
    throw new Error('Installed Nx executable is missing or outside its package.');
  }
  return executable;
}

export function runNx(args, cwd = root) {
  const result = spawnSync(process.execPath, [nxExecutable(cwd), ...args], {
    cwd, stdio: 'inherit', env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Nx exited unsuccessfully: ${result.signal ?? result.status}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { runNx(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
