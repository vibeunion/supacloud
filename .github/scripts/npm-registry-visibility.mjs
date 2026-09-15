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
 * npm view can lag several minutes behind a successful provenance publish.
 * @param {string} packageSpec
 * @param {string} expectedVersion
 * @param {NpmRunner} runNpm
 * @param {{
 *   sleep?: (ms: number) => Promise<void>,
 *   delays?: readonly number[],
 * }} [options]
 */
export async function waitForRegistryVersion(packageSpec, expectedVersion, runNpm, options = {}) {
  const delays = options.delays ?? REGISTRY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
  let attempt = 0;
  for (;;) {
    const published = await viewRegistryVersion(packageSpec, runNpm);
    if (published === expectedVersion) return published;
    if (published !== undefined) {
      throw new Error(`npm returned ${published} for exact package spec ${packageSpec}`);
    }
    const delay = delays[attempt];
    if (delay === undefined) {
      throw new Error(`Registry does not yet list ${packageSpec}`);
    }
    await sleep(delay);
    attempt += 1;
  }
}
