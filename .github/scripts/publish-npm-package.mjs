import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const NOT_FOUND_PATTERN = /(?:^|\n)npm (?:error|ERR!) (?:(?:code )?E404|404(?: Not Found)?)(?:\s|$)|["']code["']\s*:\s*["']E404["']/i;
const PUBLISH_ARGUMENTS = ['publish', '--provenance', '--access', 'public'];

async function runNpmCommand(arguments_) {
  return execFileAsync('npm', arguments_, { encoding: 'utf8' });
}

function packageIdentity(candidatePackage) {
  const { name, version } = candidatePackage;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('package.json has no package name');
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${name} has no package version`);
  }
  return { name, version };
}

function registryVersion(commandOutput, packageSpec) {
  const parsedVersion = JSON.parse(commandOutput);
  if (typeof parsedVersion !== 'string') {
    throw new Error(`npm returned an invalid version for ${packageSpec}`);
  }
  return parsedVersion;
}

function isExplicitNotFound(error) {
  const npmErrorOutput = [error?.stdout, error?.stderr]
    .filter((candidate) => typeof candidate === 'string')
    .join('\n');
  return NOT_FOUND_PATTERN.test(npmErrorOutput);
}

async function publishedVersion(packageSpec, runNpm) {
  try {
    const { stdout } = await runNpm(['view', packageSpec, 'version', '--json']);
    return registryVersion(stdout, packageSpec);
  } catch (error) {
    if (isExplicitNotFound(error)) return undefined;
    throw error;
  }
}

export async function publishNpmPackage({ name, version, runNpm = runNpmCommand }) {
  const packageSpec = `${name}@${version}`;
  const existingVersion = await publishedVersion(packageSpec, runNpm);
  if (existingVersion !== undefined) {
    if (existingVersion !== version) {
      throw new Error(`npm returned ${existingVersion} for exact package spec ${packageSpec}`);
    }
    return { packageSpec, status: 'already-published' };
  }

  await runNpm(PUBLISH_ARGUMENTS);
  return { packageSpec, status: 'published' };
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8'));
  const publication = await publishNpmPackage(packageIdentity(packageJson));
  console.log(`${publication.status}: ${publication.packageSpec}`);
}
