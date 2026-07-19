import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FROZEN = 'frozen';
const LOCAL_CANDIDATE = 'local-candidate';
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function dependencyMatches(dependencies, packageName, version) {
  return typeof version === 'string' && dependencies?.[packageName] === `^${version}`;
}

function lockfileHasCandidate(lockfile, packageName, version) {
  return typeof version === 'string' && lockfile.includes(`"${packageName}@${version}"`);
}

export function selectSupacloudInstallMode({
  eventName,
  ref,
  prAuthor,
  headRef,
  supacloudPackage,
  cliPackage,
  adminPackage,
  lockfile,
}) {
  const dependencies = supacloudPackage?.dependencies;
  const dependenciesMatchCandidates =
    dependencyMatches(dependencies, '@supacloud/cli', cliPackage?.version) &&
    dependencyMatches(dependencies, '@supacloud/admin', adminPackage?.version);
  const lockfileHasCandidates =
    lockfileHasCandidate(lockfile, '@supacloud/cli', cliPackage?.version) &&
    lockfileHasCandidate(lockfile, '@supacloud/admin', adminPackage?.version);
  const trustedReleaseContext =
    (eventName === 'push' && ref === 'refs/heads/main') ||
    (eventName === 'pull_request' &&
      prAuthor === 'github-actions[bot]' &&
      headRef === 'release-please--branches--main');

  return trustedReleaseContext && dependenciesMatchCandidates && !lockfileHasCandidates
    ? LOCAL_CANDIDATE
    : FROZEN;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function selectSupacloudInstallModeFromRepository({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
} = {}) {
  const packageRoot = resolve(repoRoot, 'packages');
  const [supacloudPackage, cliPackage, adminPackage, lockfile] = await Promise.all([
    readJson(resolve(packageRoot, 'supacloud/package.json')),
    readJson(resolve(packageRoot, 'cli/package.json')),
    readJson(resolve(packageRoot, 'admin/package.json')),
    readFile(resolve(packageRoot, 'supacloud/bun.lock'), 'utf8'),
  ]);

  return selectSupacloudInstallMode({
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    prAuthor: env.PR_AUTHOR,
    headRef: env.GITHUB_HEAD_REF,
    supacloudPackage,
    cliPackage,
    adminPackage,
    lockfile,
  });
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    console.log(await selectSupacloudInstallModeFromRepository());
  } catch (error) {
    console.error(`Failed to select SupaCloud install mode: ${error.message}`);
    process.exitCode = 1;
  }
}
