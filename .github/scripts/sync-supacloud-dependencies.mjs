import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MANAGED_DEPENDENCIES = [
  ['@supacloud/cli', 'cli'],
  ['@supacloud/admin', 'admin'],
];

function packageVersion(candidatePackage, packageName) {
  const version = candidatePackage?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${packageName} has an invalid version`);
  }
  return version;
}

export function syncSupacloudDependencies({ supacloudPackage, cliPackage, adminPackage }) {
  if (!supacloudPackage?.dependencies || typeof supacloudPackage.dependencies !== 'object') {
    throw new Error('supacloud package has no dependencies object');
  }

  const candidates = { cli: cliPackage, admin: adminPackage };
  const nextPackage = structuredClone(supacloudPackage);
  let changed = false;

  for (const [dependencyName, candidateName] of MANAGED_DEPENDENCIES) {
    const nextRange = `^${packageVersion(candidates[candidateName], dependencyName)}`;
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
    console.log(synchronization.changed ? 'updated' : 'already-synchronized');
  } catch (error) {
    console.error(`Failed to sync SupaCloud dependencies: ${error.message}`);
    process.exitCode = 1;
  }
}
