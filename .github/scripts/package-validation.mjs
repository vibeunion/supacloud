const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} candidatePackage @param {string} packageName */
export function packageVersion(candidatePackage, packageName) {
  const version = isRecord(candidatePackage) ? candidatePackage['version'] : undefined;
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`${packageName} has an invalid version`);
  }
  return version;
}

/**
 * @param {unknown} candidatePackage
 * @param {string} packageName
 * @returns {Record<string, unknown> & {dependencies: Record<string, unknown>}}
 */
export function packageWithDependencies(candidatePackage, packageName) {
  if (!isRecord(candidatePackage) || !isRecord(candidatePackage['dependencies'])) {
    throw new Error(`${packageName} package has no dependencies object`);
  }
  return { ...candidatePackage, dependencies: candidatePackage['dependencies'] };
}

/** @typedef {[bigint, bigint, bigint]} VersionPrecedence */

/** @param {string} version @param {string} packageName @returns {VersionPrecedence} */
export function stableVersionPrecedence(version, packageName) {
  if (!SEMVER_PATTERN.test(version)) throw new Error(`${packageName} has an invalid version`);
  const precedence = version.split('+', 1)[0];
  if (precedence === undefined) throw new Error(`${packageName} has an invalid version`);
  if (precedence.includes('-')) {
    throw new Error(`${packageName} prerelease versions are not supported for automatic synchronization`);
  }
  const [major, minor, patch] = precedence.split('.');
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`${packageName} has an invalid version`);
  }
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

/** @param {VersionPrecedence} leftVersion @param {VersionPrecedence} rightVersion */
export function comparePrecedence(leftVersion, rightVersion) {
  for (const [index, left] of leftVersion.entries()) {
    const right = rightVersion[index];
    if (right === undefined) throw new Error('Missing version component');
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

/** @param {unknown} range @param {string} dependencyName @returns {VersionPrecedence} */
export function caretLowerBound(range, dependencyName) {
  if (typeof range !== 'string' || !range.startsWith('^') || !SEMVER_PATTERN.test(range.slice(1))) {
    throw new Error(`${dependencyName} has an unsupported dependency range`);
  }
  return stableVersionPrecedence(range.slice(1), `${dependencyName} dependency range`);
}
