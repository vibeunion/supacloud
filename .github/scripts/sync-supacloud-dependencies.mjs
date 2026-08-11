import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MANAGED_DEPENDENCIES = [
  ['@supacloud/cli', 'cli'],
  ['@supacloud/admin', 'admin'],
];
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

function caretLowerBound(range, dependencyName) {
  if (typeof range !== 'string' || !range.startsWith('^')) {
    throw new Error(`${dependencyName} has an unsupported dependency range`);
  }
  const lowerVersion = range.slice(1);
  if (!SEMVER_PATTERN.test(lowerVersion)) {
    throw new Error(`${dependencyName} has an unsupported dependency range`);
  }
  return stableVersionPrecedence(lowerVersion, `${dependencyName} dependency range`);
}

function synchronizedRange(currentRange, candidatePackage, dependencyName) {
  const candidateVersion = packageVersion(candidatePackage, dependencyName);
  const candidatePrecedence = stableVersionPrecedence(candidateVersion, dependencyName);
  const lowerBound = caretLowerBound(currentRange, dependencyName);
  const precedence = comparePrecedence(candidatePrecedence, lowerBound);
  if (precedence < 0) {
    throw new Error(`${dependencyName} candidate ${candidateVersion} is below current lower bound ${currentRange}`);
  }
  if (precedence === 0) {
    return currentRange;
  }
  return `^${candidateVersion}`;
}

export function syncSupacloudDependencies({ supacloudPackage, cliPackage, adminPackage }) {
  if (!supacloudPackage?.dependencies || typeof supacloudPackage.dependencies !== 'object') {
    throw new Error('supacloud package has no dependencies object');
  }

  const candidates = { cli: cliPackage, admin: adminPackage };
  const nextPackage = structuredClone(supacloudPackage);
  let changed = false;

  for (const [dependencyName, candidateName] of MANAGED_DEPENDENCIES) {
    const currentRange = nextPackage.dependencies[dependencyName];
    const nextRange = synchronizedRange(currentRange, candidates[candidateName], dependencyName);
    if (nextPackage.dependencies[dependencyName] !== nextRange) {
      nextPackage.dependencies[dependencyName] = nextRange;
      changed = true;
    }
  }

  return { changed, package: nextPackage };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function repositoryPackages(repoRoot = DEFAULT_REPO_ROOT) {
  const packageRoot = resolve(repoRoot, 'packages');
  const supacloudPath = resolve(packageRoot, 'supacloud/package.json');
  const [supacloudPackage, cliPackage, adminPackage] = await Promise.all([
    readJson(supacloudPath),
    readJson(resolve(packageRoot, 'cli/package.json')),
    readJson(resolve(packageRoot, 'admin/package.json')),
  ]);
  return { supacloudPath, supacloudPackage, cliPackage, adminPackage };
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const repository = await repositoryPackages();
    const synchronization = syncSupacloudDependencies(repository);
    if (synchronization.changed) {
      await writeFile(repository.supacloudPath, `${JSON.stringify(synchronization.package, null, 2)}\n`);
    }
    console.log(`changed=${synchronization.changed}`);
  } catch (error) {
    console.error(`Failed to sync SupaCloud dependencies: ${error.message}`);
    process.exitCode = 1;
  }
}
