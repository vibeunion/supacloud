import { isRecord } from './package-validation.mjs';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const REGISTRY_RETRY_DELAYS_MS = /** @type {readonly number[]} */ ([
  2_000,
  4_000,
  8_000,
  16_000,
  ...Array.from({ length: 24 }, () => 30_000),
]);

const NPM_NOT_FOUND_PATTERN = /(?:^|\n)npm (?:error|ERR!) (?:(?:code )?E404|404(?: Not Found)?)(?:\s|$)|No match found for version|["']code["']\s*:\s*["']E404["']/i;

/** @typedef {(arguments_: string[]) => Promise<{ stdout?: unknown, stderr?: unknown }>} NpmRunner */
/** @typedef {{sleep?: (ms: number) => Promise<void>, delays?: readonly number[]}} RegistryRetryOptions */

/** @param {unknown} error */
export function isNpmNotFoundError(error) {
  const record = isRecord(error) ? error : {};
  const text = [record['stdout'], record['stderr'], error instanceof Error ? error.message : error]
    .filter((value) => typeof value === 'string')
    .join('\n');
  return NPM_NOT_FOUND_PATTERN.test(text);
}

/** @param {string} commandOutput @param {string} packageSpec */
export function parseRegistryVersion(commandOutput, packageSpec) {
  /** @type {unknown} */
  const parsedVersion = JSON.parse(commandOutput);
  if (typeof parsedVersion !== 'string') {
    throw new Error(`npm returned an invalid version for ${packageSpec}`);
  }
  return parsedVersion;
}

/**
 * @param {string} packageSpec
 * @param {NpmRunner} runNpm
 * @returns {Promise<string | undefined>}
 */
export async function viewRegistryVersion(packageSpec, runNpm) {
  try {
    const result = await runNpm(['view', packageSpec, 'version', '--json', `--registry=${NPM_REGISTRY}`]);
    const stdout = result.stdout;
    if (typeof stdout !== 'string') {
      throw new Error(`npm returned an invalid version for ${packageSpec}`);
    }
    return parseRegistryVersion(stdout, packageSpec);
  } catch (error) {
    if (isNpmNotFoundError(error)) return undefined;
    throw error;
  }
}

/**
 * @param {() => Promise<string | undefined>} read
 * @param {string} timeoutMessage
 * @param {RegistryRetryOptions} options
 */
async function waitForRegistryRead(read, timeoutMessage, options) {
  const delays = options.delays ?? REGISTRY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
  for (let attempt = 0; ; attempt += 1) {
    const result = await read();
    if (result !== undefined) return result;
    const delay = delays[attempt];
    if (delay === undefined) throw new Error(timeoutMessage);
    await sleep(delay);
  }
}

/**
 * npm view can lag several minutes behind a successful provenance publish.
 * @param {string} packageSpec
 * @param {string} expectedVersion
 * @param {NpmRunner} runNpm
 * @param {RegistryRetryOptions} [options]
 */
export async function waitForRegistryVersion(packageSpec, expectedVersion, runNpm, options = {}) {
  return waitForRegistryRead(async () => {
    const published = await viewRegistryVersion(packageSpec, runNpm);
    if (published !== undefined && published !== expectedVersion) {
      throw new Error(`npm returned ${published} for exact package spec ${packageSpec}`);
    }
    return published;
  }, `Registry does not yet list ${packageSpec}`, options);
}

/**
 * Version metadata can be visible while the actual tarball still returns 404.
 * A dry-run pack downloads and checks the tarball without writing a package.
 * @param {string} packageSpec
 * @param {NpmRunner} runNpm
 * @param {RegistryRetryOptions} [options]
 */
export async function waitForRegistryTarball(packageSpec, runNpm, options = {}) {
  await waitForRegistryRead(async () => {
    try {
      await runNpm([
        'pack', packageSpec, '--dry-run', '--ignore-scripts', '--prefer-online', `--registry=${NPM_REGISTRY}`,
      ]);
      return packageSpec;
    } catch (error) {
      const stderr = isRecord(error) ? error['stderr'] : undefined;
      if (isNpmNotFoundError(error) || (typeof stderr === 'string' && /^npm (?:error|ERR!) code ETARGET\s*$/m.test(stderr))) {
        return undefined;
      }
      throw error;
    }
  }, `Registry tarball is not yet downloadable: ${packageSpec}`, options);
}
