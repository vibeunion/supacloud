import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isNpmNotFoundError, NPM_REGISTRY, viewRegistryVersion, waitForRegistryVersion } from './npm-registry-visibility.mjs';

const execFileAsync = promisify(execFile);
const PUBLISH_ARGUMENTS = ['publish', '--provenance', '--access', 'public', `--registry=${NPM_REGISTRY}`];
const MAX_NPM_OUTPUT_BYTES = 16 * 1024 * 1024;

/** @typedef {(arguments_: string[]) => Promise<{ stdout?: unknown, stderr?: unknown }>} NpmRunner */

/** @param {string[]} arguments_ */
async function runNpmCommand(arguments_) {
  return execFileAsync('npm', arguments_, { encoding: 'utf8', maxBuffer: MAX_NPM_OUTPUT_BYTES });
}

/** @param {unknown} candidatePackage */
function packageIdentity(candidatePackage) {
  if (!candidatePackage || typeof candidatePackage !== 'object') {
    throw new Error('package.json must be an object');
  }
  const { name, version } = /** @type {{ name?: unknown, version?: unknown }} */ (candidatePackage);
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('package.json has no package name');
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${name} has no package version`);
  }
  return { name, version };
}

/**
 * @param {{
 *   name: string,
 *   version: string,
 *   runNpm?: NpmRunner,
 *   sleep?: (ms: number) => Promise<void>,
 *   delays?: readonly number[],
 * }} options
 */
export async function publishNpmPackage(options) {
  const { name, version } = packageIdentity(options);
  const runNpm = options.runNpm ?? runNpmCommand;
  const packageSpec = `${name}@${version}`;
  const existingVersion = await viewRegistryVersion(packageSpec, runNpm);
  if (existingVersion !== undefined) {
    if (existingVersion !== version) {
      throw new Error(`npm returned ${existingVersion} for exact package spec ${packageSpec}`);
    }
    return { packageSpec, status: /** @type {const} */ ('already-published') };
  }

  let published;
  try {
    published = await runNpm(PUBLISH_ARGUMENTS);
  } catch (error) {
    if (isNpmNotFoundError(error)) {
      throw new Error(
        `npm rejected publication of ${packageSpec} with E404; this is not registry propagation delay. `
        + `Check the npm Trusted Publisher configured for ${name}: GitHub owner/repository, `
        + 'workflow filename, environment name, and permission for direct npm publish. '
        + 'If the package has never been published, publish it manually first, then configure its Trusted Publisher. '
        + 'Verify id-token: write and an OIDC-capable npm CLI in the publishing job; '
        + 'npm whoami does not verify OIDC authentication.',
        { cause: error },
      );
    }
    throw error;
  }
  const stdout = typeof published.stdout === 'string' ? published.stdout : '';
  const stderr = typeof published.stderr === 'string' ? published.stderr : '';
  try {
    await waitForRegistryVersion(packageSpec, version, runNpm, options);
  } catch (error) {
    const detail = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join('\n');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(detail ? `${message}\n${detail}` : message);
  }
  return { packageSpec, status: /** @type {const} */ ('published'), stdout, stderr };
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8'));
  const publication = await publishNpmPackage(packageIdentity(packageJson));
  if (publication.status === 'published') {
    if (publication.stdout.trim()) console.log(publication.stdout.trimEnd());
    if (publication.stderr.trim()) console.error(publication.stderr.trimEnd());
  }
  console.log(`${publication.status}: ${publication.packageSpec}`);
}
