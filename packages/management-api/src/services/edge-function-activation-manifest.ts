import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse as parsePath, relative, resolve, sep } from "node:path";

export const EDGE_FUNCTION_ACTIVATION_SCHEMA = "supacloud.edge-function-activation.v1" as const;
export const EDGE_FUNCTION_ACTIVATION_FIELD = "_supacloud_activation" as const;
export const EDGE_FUNCTION_ACTIVATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const FUNCTION_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CANONICAL_VERSION_PATTERN = /^(?:0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const AUTHORITY_KEYS = [
  "schema",
  "activation_id",
  "activation_generation",
  "previous_activation_id",
  "target_state",
  "artifact_sha256",
] as const;

export type EdgeFunctionActivationAuthority = {
  schema: typeof EDGE_FUNCTION_ACTIVATION_SCHEMA;
  activation_id: string;
  activation_generation: number;
  previous_activation_id: string | null;
  target_state: "active" | "absent";
  artifact_sha256: string | null;
};

export type EdgeFunctionActivationManifest = {
  config: Record<string, unknown>;
  authority: EdgeFunctionActivationAuthority | null;
};

export class EdgeFunctionActivationDurabilityError extends Error {
  constructor(
    readonly activationId: string,
    cause: unknown,
  ) {
    super("Function activation manifest durability is uncertain", { cause });
    this.name = "EdgeFunctionActivationDurabilityError";
  }
}

type WriteActivationGenerationRequest = {
  projectDirectory: string;
  functionSlug: string;
  config: Record<string, unknown>;
  authority: EdgeFunctionActivationAuthority;
};

type ReplaceActivationManifestRequest = {
  manifestPath: string;
  config: Record<string, unknown>;
  authority: EdgeFunctionActivationAuthority;
};

type EdgeFunctionMutationPreflightRequest = {
  projectDirectory: string;
  functionSlug: string;
};

function isPlainRecord(candidate: unknown): candidate is Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const prototype = Object.getPrototypeOf(candidate);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(record).sort();
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key, index) => actualKeys[index] === key);
}

function nullableActivationId(candidate: unknown): candidate is string | null {
  return candidate === null
    || (typeof candidate === "string" && EDGE_FUNCTION_ACTIVATION_ID_PATTERN.test(candidate));
}

export function parseEdgeFunctionActivationAuthority(
  candidate: unknown,
): EdgeFunctionActivationAuthority {
  if (!isPlainRecord(candidate) || !hasExactKeys(candidate, [...AUTHORITY_KEYS].sort())) {
    throw new Error("Function activation authority has an invalid shape");
  }
  if (candidate.schema !== EDGE_FUNCTION_ACTIVATION_SCHEMA
    || typeof candidate.activation_id !== "string"
    || !EDGE_FUNCTION_ACTIVATION_ID_PATTERN.test(candidate.activation_id)
    || !Number.isSafeInteger(candidate.activation_generation)
    || Number(candidate.activation_generation) < 1
    || !nullableActivationId(candidate.previous_activation_id)
    || (candidate.target_state !== "active" && candidate.target_state !== "absent")) {
    throw new Error("Function activation authority contains invalid identity fields");
  }
  const artifactSha256 = candidate.artifact_sha256;
  if (candidate.target_state === "active") {
    if (typeof artifactSha256 !== "string" || !SHA256_PATTERN.test(artifactSha256)) {
      throw new Error("Active Function activation authority requires an artifact digest");
    }
  } else if (artifactSha256 !== null) {
    throw new Error("Absent Function activation authority cannot identify an artifact");
  }
  return candidate as EdgeFunctionActivationAuthority;
}

export function parseEdgeFunctionActivationManifest(
  rawManifest: string,
): EdgeFunctionActivationManifest {
  const parsed: unknown = JSON.parse(rawManifest);
  if (!isPlainRecord(parsed)) throw new Error("Function config must be an object");
  const config = { ...parsed };
  const rawAuthority = config[EDGE_FUNCTION_ACTIVATION_FIELD];
  delete config[EDGE_FUNCTION_ACTIVATION_FIELD];
  return {
    config,
    authority: rawAuthority === undefined
      ? null
      : parseEdgeFunctionActivationAuthority(rawAuthority),
  };
}

export function serializeEdgeFunctionActivationManifest(
  config: Record<string, unknown>,
  authority: EdgeFunctionActivationAuthority,
): string {
  return JSON.stringify({
    ...config,
    [EDGE_FUNCTION_ACTIVATION_FIELD]: authority,
  }, null, 2);
}

export function edgeFunctionActivationGenerationPath(
  projectDirectory: string,
  functionSlug: string,
  activationId: string,
): string {
  if (!FUNCTION_SLUG_PATTERN.test(functionSlug)) {
    throw new Error("Invalid Function slug");
  }
  if (!EDGE_FUNCTION_ACTIVATION_ID_PATTERN.test(activationId)) {
    throw new Error("Invalid Function activation identifier");
  }
  return join(
    projectDirectory,
    ".activation-generations",
    functionSlug,
    `${activationId}.json`,
  );
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertTrustedDirectory(metadata: Stats): void {
  const effectiveUid = process.geteuid?.();
  const trustedOwner = effectiveUid !== undefined
    && (metadata.uid === 0 || metadata.uid === effectiveUid);
  if (!metadata.isDirectory() || !trustedOwner || (metadata.mode & 0o022) !== 0) {
    throw new Error("Function mutation directory is not trusted");
  }
}

function hasSameDirectoryIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

async function createDirectoryIfMissing(directoryPath: string): Promise<void> {
  try {
    await mkdir(directoryPath, { mode: 0o755 });
  } catch (error: unknown) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

async function openTrustedDirectory(
  directoryPath: string,
): Promise<FileHandle> {
  const pathMetadata = await lstat(directoryPath);
  assertTrustedDirectory(pathMetadata);
  const directory = await open(directoryPath, DIRECTORY_OPEN_FLAGS);
  try {
    const descriptorMetadata = await directory.stat();
    assertTrustedDirectory(descriptorMetadata);
    if (!hasSameDirectoryIdentity(pathMetadata, descriptorMetadata)) {
      throw new Error("Function mutation directory identity changed");
    }
    return directory;
  } catch (error: unknown) {
    await directory.close();
    throw error;
  }
}

function canonicalDirectoryChain(directoryPath: string): string[] {
  const canonicalPath = resolve(directoryPath);
  if (canonicalPath !== directoryPath) {
    throw new Error("Function mutation directory path is not canonical");
  }
  const filesystemRoot = parsePath(canonicalPath).root;
  const pathSegments = relative(filesystemRoot, canonicalPath)
    .split(sep)
    .filter(Boolean);
  const chain = [filesystemRoot];
  for (const pathSegment of pathSegments) {
    chain.push(join(chain.at(-1)!, pathSegment));
  }
  return chain;
}

async function openTrustedDirectoryChain(directoryPath: string): Promise<FileHandle> {
  if (await realpath(directoryPath) !== directoryPath) {
    throw new Error("Function mutation directory path is not canonical");
  }
  let trustedDirectory: FileHandle | null = null;
  try {
    for (const pathEntry of canonicalDirectoryChain(directoryPath)) {
      const nextDirectory = await openTrustedDirectory(pathEntry);
      await trustedDirectory?.close();
      trustedDirectory = nextDirectory;
    }
    if (!trustedDirectory) throw new Error("Function mutation directory is unavailable");
    return trustedDirectory;
  } catch (error: unknown) {
    await trustedDirectory?.close();
    throw error;
  }
}

async function openExistingTrustedDirectory(
  parentDirectory: FileHandle,
  directoryPath: string,
): Promise<FileHandle | null> {
  try {
    return await openTrustedDirectory(directoryEntryPath(parentDirectory, directoryPath));
  } catch (error: unknown) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function inspectExistingTrustedDirectoryPair(
  parentDirectory: FileHandle,
  directoryPath: string,
  childDirectoryPath: string,
): Promise<void> {
  const directory = await openExistingTrustedDirectory(parentDirectory, directoryPath);
  if (!directory) return;
  try {
    const childDirectory = await openExistingTrustedDirectory(directory, childDirectoryPath);
    await childDirectory?.close();
  } finally {
    await directory.close();
  }
}

async function inspectCanonicalVersionDirectories(
  versionSlugDirectory: FileHandle,
  versionSlugPath: string,
): Promise<void> {
  const entries = await readdir(
    openedDirectoryPath(versionSlugDirectory, versionSlugPath),
    { withFileTypes: true },
  );
  for (const entry of entries) {
    if (!CANONICAL_VERSION_PATTERN.test(entry.name)
      || !Number.isSafeInteger(Number(entry.name))) continue;
    const versionPath = join(versionSlugPath, entry.name);
    const versionDirectory = await openTrustedDirectory(
      directoryEntryPath(versionSlugDirectory, versionPath),
    );
    await versionDirectory.close();
  }
}

async function inspectExistingVersionMutationParents(
  projectDirectory: FileHandle,
  request: EdgeFunctionMutationPreflightRequest,
): Promise<void> {
  const versionRootPath = join(request.projectDirectory, ".versions");
  const versionRoot = await openExistingTrustedDirectory(projectDirectory, versionRootPath);
  if (!versionRoot) return;
  try {
    const versionSlugPath = join(versionRootPath, request.functionSlug);
    const versionSlug = await openExistingTrustedDirectory(versionRoot, versionSlugPath);
    if (!versionSlug) return;
    try {
      await inspectCanonicalVersionDirectories(versionSlug, versionSlugPath);
    } finally {
      await versionSlug.close();
    }
  } finally {
    await versionRoot.close();
  }
}

async function inspectExistingFunctionMutationParents(
  projectDirectory: FileHandle,
  request: EdgeFunctionMutationPreflightRequest,
): Promise<void> {
  const activationRoot = join(request.projectDirectory, ".activation-generations");
  await inspectExistingTrustedDirectoryPair(
    projectDirectory,
    activationRoot,
    join(activationRoot, request.functionSlug),
  );
  await inspectExistingVersionMutationParents(projectDirectory, request);
}

async function inspectExistingProjectMutationParents(
  functionsRoot: FileHandle,
  request: EdgeFunctionMutationPreflightRequest,
): Promise<void> {
  const projectDirectory = await openExistingTrustedDirectory(
    functionsRoot,
    request.projectDirectory,
  );
  if (!projectDirectory) return;
  try {
    await inspectExistingFunctionMutationParents(projectDirectory, request);
  } finally {
    await projectDirectory.close();
  }
}

export async function preflightEdgeFunctionMutationDirectories(
  request: EdgeFunctionMutationPreflightRequest,
): Promise<void> {
  if (!FUNCTION_SLUG_PATTERN.test(request.functionSlug)) {
    throw new Error("Invalid Function slug");
  }
  const functionsRoot = await openTrustedDirectoryChain(dirname(request.projectDirectory));
  try {
    await inspectExistingProjectMutationParents(functionsRoot, request);
  } finally {
    await functionsRoot.close();
  }
}

async function createTrustedDirectory(directoryPath: string): Promise<FileHandle> {
  await createDirectoryIfMissing(directoryPath);
  const directory = await openTrustedDirectory(directoryPath);
  try {
    await directory.chmod(0o755);
    return directory;
  } catch (error: unknown) {
    await directory.close();
    throw error;
  }
}

function directoryEntryPath(
  directory: FileHandle,
  absoluteEntryPath: string,
): string {
  return process.platform === "linux"
    ? `/proc/self/fd/${directory.fd}/${basename(absoluteEntryPath)}`
    : absoluteEntryPath;
}

function openedDirectoryPath(
  directory: FileHandle,
  absoluteDirectoryPath: string,
): string {
  return process.platform === "linux"
    ? `/proc/self/fd/${directory.fd}`
    : absoluteDirectoryPath;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function syncActivationManifestDirectory(
  manifestPath: string,
  activationId: string,
): Promise<void> {
  try {
    await syncDirectory(dirname(manifestPath));
  } catch (error: unknown) {
    throw new EdgeFunctionActivationDurabilityError(activationId, error);
  }
}

async function writeSyncedExclusive(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const file = await open(filePath, "wx", mode);
  try {
    await file.writeFile(content, "utf8");
    await file.chmod(mode);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeActivationGenerationFile(
  generationDirectory: FileHandle,
  generationPath: string,
  content: string,
): Promise<void> {
  const boundGenerationPath = directoryEntryPath(generationDirectory, generationPath);
  await writeSyncedExclusive(boundGenerationPath, content, 0o444);
  await generationDirectory.sync();
  if (await readFile(boundGenerationPath, "utf8") !== content) {
    throw new Error("Function activation generation readback did not match");
  }
}

async function writeActivationGenerationInProject(
  projectDirectory: FileHandle,
  request: WriteActivationGenerationRequest,
  generationPath: string,
): Promise<void> {
  const activationRootPath = join(request.projectDirectory, ".activation-generations");
  const activationRoot = await createTrustedDirectory(
    directoryEntryPath(projectDirectory, activationRootPath),
  );
  try {
    await writeActivationGenerationUnderRoot(activationRoot, request, generationPath);
  } finally {
    await activationRoot.close();
  }
}

async function writeActivationGenerationUnderRoot(
  activationRoot: FileHandle,
  request: WriteActivationGenerationRequest,
  generationPath: string,
): Promise<void> {
  const generationDirectory = await createTrustedDirectory(
    directoryEntryPath(activationRoot, dirname(generationPath)),
  );
  try {
    const content = serializeEdgeFunctionActivationManifest(request.config, request.authority);
    await writeActivationGenerationFile(generationDirectory, generationPath, content);
  } finally {
    await generationDirectory.close();
  }
}

export async function writeEdgeFunctionActivationGeneration(
  request: WriteActivationGenerationRequest,
): Promise<string> {
  const generationPath = edgeFunctionActivationGenerationPath(
    request.projectDirectory,
    request.functionSlug,
    request.authority.activation_id,
  );
  const functionsRoot = await openTrustedDirectoryChain(dirname(request.projectDirectory));
  try {
    const projectDirectory = await openTrustedDirectory(
      directoryEntryPath(functionsRoot, request.projectDirectory),
    );
    try {
      await writeActivationGenerationInProject(projectDirectory, request, generationPath);
    } finally {
      await projectDirectory.close();
    }
  } finally {
    await functionsRoot.close();
  }
  return generationPath;
}

export async function replaceEdgeFunctionActivationManifest(
  request: ReplaceActivationManifestRequest,
): Promise<void> {
  const content = serializeEdgeFunctionActivationManifest(request.config, request.authority);
  const temporaryPath = `${request.manifestPath}.${request.authority.activation_id}.tmp`;
  try {
    await writeSyncedExclusive(temporaryPath, content, 0o444);
    await rename(temporaryPath, request.manifestPath);
    await syncActivationManifestDirectory(
      request.manifestPath,
      request.authority.activation_id,
    );
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function confirmEdgeFunctionActivationManifestDurable(
  manifestPath: string,
  activationId: string,
): Promise<void> {
  await syncActivationManifestDirectory(manifestPath, activationId);
  const current = parseEdgeFunctionActivationManifest(await readFile(manifestPath, "utf8"));
  if (current.authority?.activation_id !== activationId) {
    throw new Error("Function activation manifest changed during durability confirmation");
  }
}
