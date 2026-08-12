import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type HeldDirectory = {
  descriptor: FileHandle;
  path: string;
  identity: Stats;
};

export type TrustedFunctionFile = {
  path: string;
  bytes: Buffer;
  sha256: string;
  metadata: Stats;
};

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertTrustedDirectory(metadata: Stats): void {
  const effectiveUid = process.geteuid?.();
  const trustedOwner = effectiveUid !== undefined
    && (metadata.uid === 0 || metadata.uid === effectiveUid);
  if (!metadata.isDirectory() || !trustedOwner || (metadata.mode & 0o022) !== 0) {
    throw new Error("Function runtime directory is not trusted");
  }
}

function assertTrustedRegularFile(metadata: Stats, requireTrustedOwner = true): void {
  const effectiveUid = process.geteuid?.();
  const trustedOwner = effectiveUid !== undefined
    && (metadata.uid === 0 || metadata.uid === effectiveUid);
  if (!metadata.isFile()
    || (requireTrustedOwner && (!trustedOwner || (metadata.mode & 0o022) !== 0))) {
    throw new Error("Function runtime file is not trusted");
  }
}

function canonicalDirectoryChain(directoryPath: string): string[] {
  const filesystemRoot = parse(directoryPath).root;
  const pathSegments = relative(filesystemRoot, directoryPath).split(sep).filter(Boolean);
  const chain = [filesystemRoot];
  for (const pathSegment of pathSegments) chain.push(join(chain.at(-1)!, pathSegment));
  return chain;
}

async function heldDirectory(directoryPath: string, openPath: string): Promise<HeldDirectory> {
  const pathMetadata = await lstat(directoryPath);
  assertTrustedDirectory(pathMetadata);
  const descriptor = await open(openPath, DIRECTORY_OPEN_FLAGS);
  try {
    const descriptorMetadata = await descriptor.stat();
    assertTrustedDirectory(descriptorMetadata);
    if (!sameIdentity(pathMetadata, descriptorMetadata)) {
      throw new Error("Function runtime directory identity changed");
    }
    return { descriptor, path: directoryPath, identity: descriptorMetadata };
  } catch (error: unknown) {
    await descriptor.close();
    throw error;
  }
}

async function heldTrustedDirectoryChain(directoryPath: string): Promise<HeldDirectory[]> {
  if (process.platform !== "linux") {
    throw new Error("Attested Function artifacts require Linux descriptor binding");
  }
  const canonicalPath = await realpath(directoryPath);
  if (canonicalPath !== resolve(directoryPath)) {
    throw new Error("Function runtime directory path is not canonical");
  }
  const heldDirectories: HeldDirectory[] = [];
  try {
    for (const pathEntry of canonicalDirectoryChain(canonicalPath)) {
      const parent = heldDirectories.at(-1);
      const openPath = parent
        ? `/proc/self/fd/${parent.descriptor.fd}/${basename(pathEntry)}`
        : pathEntry;
      heldDirectories.push(await heldDirectory(pathEntry, openPath));
    }
    return heldDirectories;
  } catch (error: unknown) {
    await closeHeldDirectories(heldDirectories);
    throw error;
  }
}

async function closeHeldDirectories(heldDirectories: HeldDirectory[]): Promise<void> {
  await Promise.all(heldDirectories.map(({ descriptor }) => descriptor.close()));
}

async function assertHeldDirectoryBindings(heldDirectories: HeldDirectory[]): Promise<void> {
  for (const held of heldDirectories) {
    const [descriptorMetadata, currentPath, pathMetadata] = await Promise.all([
      held.descriptor.stat(),
      readlink(`/proc/self/fd/${held.descriptor.fd}`),
      lstat(held.path),
    ]);
    if (currentPath !== held.path
      || !sameIdentity(held.identity, descriptorMetadata)
      || !sameIdentity(held.identity, pathMetadata)) {
      throw new Error("Function runtime directory binding changed");
    }
  }
}

async function assertPathBinding(filePath: string, expected: Stats): Promise<void> {
  const current = await lstat(filePath);
  if (!sameIdentity(expected, current)) {
    throw new Error("Function runtime file path changed");
  }
}

function fileChanged(before: Stats, after: Stats): boolean {
  return !sameIdentity(before, after)
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs;
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function openBoundFunctionFile(filePath: string): Promise<FileHandle> {
  try {
    return await open(filePath, FILE_OPEN_FLAGS);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
    throw new Error("Function runtime file changed before open", { cause: error });
  }
}

async function readHeldFunctionFile(
  filePath: string,
  heldDirectories: HeldDirectory[],
): Promise<TrustedFunctionFile> {
  const parent = heldDirectories.at(-1);
  if (!parent) throw new Error("Function runtime directory is unavailable");
  const entryName = basename(filePath);
  if (join(dirname(filePath), entryName) !== filePath) {
    throw new Error("Function runtime file must be a direct child");
  }
  const boundPath = `/proc/self/fd/${parent.descriptor.fd}/${entryName}`;
  const pathMetadata = await lstat(boundPath);
  assertTrustedRegularFile(pathMetadata);
  const file = await openBoundFunctionFile(boundPath);
  try {
    const before = await file.stat();
    assertTrustedRegularFile(before);
    if (!sameIdentity(pathMetadata, before)) {
      throw new Error("Function runtime file identity changed before read");
    }
    const bytes = await file.readFile();
    const after = await file.stat();
    if (fileChanged(before, after)) throw new Error("Function runtime file changed while reading");
    await assertPathBinding(filePath, after);
    await assertHeldDirectoryBindings(heldDirectories);
    return {
      path: filePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      metadata: after,
    };
  } finally {
    await file.close();
  }
}

export async function readTrustedFunctionFile(filePath: string): Promise<TrustedFunctionFile> {
  const absolutePath = resolve(filePath);
  const heldDirectories = await heldTrustedDirectoryChain(dirname(absolutePath));
  try {
    return await readHeldFunctionFile(absolutePath, heldDirectories);
  } finally {
    await closeHeldDirectories(heldDirectories);
  }
}

export async function readFunctionFile(filePath: string): Promise<TrustedFunctionFile> {
  if (process.platform === "linux") {
    return readTrustedFunctionFile(filePath);
  }
  const absolutePath = resolve(filePath);
  const pathMetadata = await lstat(absolutePath);
  assertTrustedRegularFile(pathMetadata, false);
  const file = await openBoundFunctionFile(absolutePath);
  try {
    const before = await file.stat();
    assertTrustedRegularFile(before, false);
    if (!sameIdentity(pathMetadata, before)) {
      throw new Error("Function runtime file identity changed before read");
    }
    const bytes = await file.readFile();
    const after = await file.stat();
    if (fileChanged(before, after)) throw new Error("Function runtime file changed while reading");
    await assertPathBinding(absolutePath, after);
    return {
      path: absolutePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      metadata: after,
    };
  } finally {
    await file.close();
  }
}

export async function assertTrustedFunctionArtifact(
  filePath: string,
  expectedSha256: string,
): Promise<void> {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("Function artifact SHA-256 is invalid");
  }
  const artifact = await readFunctionFile(filePath);
  if (artifact.sha256 !== expectedSha256) {
    throw new Error("Function artifact SHA-256 does not match activation authority");
  }
}

export async function withTrustedFunctionArtifact<T>(
  filePath: string,
  expectedSha256: string,
  readArtifact: (descriptorPath: string) => Promise<T>,
): Promise<T> {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("Function artifact SHA-256 is invalid");
  }
  if (process.platform !== "linux") {
    throw new Error("Attested Function imports require Linux descriptor binding");
  }
  const absolutePath = resolve(filePath);
  const heldDirectories = await heldTrustedDirectoryChain(dirname(absolutePath));
  let artifact: FileHandle | null = null;
  try {
    const parent = heldDirectories.at(-1)!;
    const boundPath = `/proc/self/fd/${parent.descriptor.fd}/${basename(absolutePath)}`;
    const pathMetadata = await lstat(boundPath);
    assertTrustedRegularFile(pathMetadata);
    artifact = await openBoundFunctionFile(boundPath);
    const metadata = await artifact.stat();
    assertTrustedRegularFile(metadata);
    if (!sameIdentity(pathMetadata, metadata)) {
      throw new Error("Function runtime file identity changed before import");
    }
    const bytes = await artifact.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new Error("Function artifact SHA-256 does not match activation authority");
    }
    await assertHeldDirectoryBindings(heldDirectories);
    const imported = await readArtifact(`/proc/self/fd/${artifact.fd}`);
    const after = await artifact.stat();
    if (fileChanged(metadata, after)) throw new Error("Function runtime file changed while importing");
    await assertHeldDirectoryBindings(heldDirectories);
    return imported;
  } finally {
    await artifact?.close();
    await closeHeldDirectories(heldDirectories);
  }
}
