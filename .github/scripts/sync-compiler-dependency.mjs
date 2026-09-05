import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function packageVersion(candidatePackage, packageName) {
  const version = candidatePackage?.version;
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`${packageName} has an invalid version`);
  }
  return version;
}

function stableVersionPrecedence(version, packageName) {
  const precedence = version.split('+', 1)[0];
  if (precedence.includes('-')) {
    throw new Error(`${packageName} prerelease versions are not supported for automatic synchronization`);
  }
  return precedence.split('.').map((identifier) => BigInt(identifier));
}

function comparePrecedence(leftVersion, rightVersion) {
  for (let index = 0; index < leftVersion.length; index += 1) {
    if (leftVersion[index] < rightVersion[index]) return -1;
    if (leftVersion[index] > rightVersion[index]) return 1;
  }
  return 0;
}

function caretLowerBound(range, dependencyName, localPackage) {
  if (typeof range === 'string' && range.startsWith('file:')) {
    // Local workspace references are valid for development, but never for a
    // published package. Force release synchronization to emit a registry range.
    packageVersion(localPackage, dependencyName);
    return [0n, 0n, 0n];
  }
  if (typeof range !== 'string' || !range.startsWith('^')) {
    throw new Error(`${dependencyName} has an unsupported dependency range`);
  }
  const lowerVersion = range.slice(1);
  if (!SEMVER_PATTERN.test(lowerVersion)) {
    throw new Error(`${dependencyName} has an unsupported dependency range`);
  }
  return stableVersionPrecedence(lowerVersion, `${dependencyName} dependency range`);
}

export function syncCompilerDependency({ cliPackage, compilerPackage }) {
  if (!cliPackage?.dependencies || typeof cliPackage.dependencies !== 'object') {
    throw new Error('CLI package has no dependencies object');
  }

  const compilerVersion = packageVersion(compilerPackage, '@supacloud/compiler');
  const compilerPrecedence = stableVersionPrecedence(compilerVersion, '@supacloud/compiler');
  const currentRange = cliPackage.dependencies['@supacloud/compiler'];
  const currentPrecedence = caretLowerBound(
    currentRange,
    '@supacloud/compiler',
    compilerPackage,
  );
  const nextPackage = structuredClone(cliPackage);
  const comparison = comparePrecedence(compilerPrecedence, currentPrecedence);

  if (comparison < 0) {
    throw new Error(
      `@supacloud/compiler candidate ${compilerVersion} is below current lower bound ${currentRange}`,
    );
  }
  if (comparison === 0) {
    return { changed: false, package: nextPackage };
  }

  nextPackage.dependencies['@supacloud/compiler'] = `^${compilerVersion}`;
  return { changed: true, package: nextPackage };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function repositoryPackages(repoRoot = DEFAULT_REPO_ROOT) {
  const cliPath = resolve(repoRoot, 'packages/cli/package.json');
  const compilerPath = resolve(repoRoot, 'packages/compiler/package.json');
  return {
    cliPath,
    cliPackage: await readJson(cliPath),
    compilerPackage: await readJson(compilerPath),
  };
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const repository = await repositoryPackages();
    const synchronization = syncCompilerDependency(repository);
    if (synchronization.changed) {
      await writeFile(repository.cliPath, `${JSON.stringify(synchronization.package, null, 2)}\n`);
    }
    console.log(`changed=${synchronization.changed}`);
  } catch (error) {
    console.error(`Failed to sync compiler dependency: ${error.message}`);
    process.exitCode = 1;
  }
}
