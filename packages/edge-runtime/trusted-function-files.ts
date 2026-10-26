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

/**
 * A trusted read that may omit the file contents when the digest of the current
 * file identity is already known. Callers that only need to prove "this path
 * still holds the artifact with digest X" must use this instead of
 * `readFunctionFile`, which always materialises the bytes.
 */
export type TrustedFunctionFileDigest = {
  path: string;
  sha256: string;
  metadata: Stats;
  bytes: Buffer | undefined;
};

export type FunctionFileReadOptions = {
  maxBytes?: number;
  /** Force materialising the bytes even when the digest is cached. */
  withBytes?: boolean;
};

const DIGEST_CACHE_LIMIT = 4096;
const digestCache = new Map<string, { identity: string; sha256: string }>();

function fileIdentity(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ].join(":");
}

function lookupDigest(filePath: string, metadata: Stats): string | null {
  const cached = digestCache.get(filePath);
  if (cached === undefined || cached.identity !== fileIdentity(metadata)) return null;
  // Refresh recency so hot artifacts survive eviction.
  digestCache.delete(filePath);
  digestCache.set(filePath, cached);
  return cached.sha256;
}

function rememberDigest(filePath: string, metadata: Stats, sha256: string): void {
  digestCache.delete(filePath);
  digestCache.set(filePath, { identity: fileIdentity(metadata), sha256 });
  while (digestCache.size > DIGEST_CACHE_LIMIT) {
    const oldest = digestCache.keys().next();
    if (oldest.done === true) break;
    digestCache.delete(oldest.value);
  }
}

/**
 * Drops cached digests. Tests and deployment-time cleanup use this; dispatch
 * paths do not need it because the cache key is the full file identity.
 */
export function clearFunctionFileDigestCache(filePath?: string): void {
  if (filePath === undefined) digestCache.clear();
  else digestCache.delete(resolve(filePath));
}

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

async function readBoundedFile(file: FileHandle, metadata: Stats, maxBytes?: number): Promise<Buffer> {
  if (maxBytes === undefined) return file.readFile();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || metadata.size > maxBytes) {
    throw new Error("Function runtime file exceeds its byte limit");
  }
  // Bound allocation and reads even when the file grows after fstat.
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let length = 0;
  while (length < bytes.length) {
    const result = await file.read(bytes, length, bytes.length - length, length);
    if (result.bytesRead === 0) break;
    length += result.bytesRead;
  }
  if (length > maxBytes) throw new Error("Function runtime file exceeds its byte limit");
  return bytes.subarray(0, length);
}

async function readHeldFunctionFile(
  filePath: string,
  heldDirectories: HeldDirectory[],
  options: FunctionFileReadOptions = {},
): Promise<TrustedFunctionFileDigest> {
  const { maxBytes, withBytes = false } = options;
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
    const knownDigest = withBytes ? null : lookupDigest(filePath, before);
    if (knownDigest !== null) {
      // The bytes are unchanged as far as the file identity can tell, so skip
      // re-reading and re-hashing them while keeping every binding check.
      if (maxBytes !== undefined && before.size > maxBytes) {
        throw new Error("Function runtime file exceeds its byte limit");
      }
      const after = await file.stat();
      if (fileChanged(before, after)) throw new Error("Function runtime file changed while reading");
      await assertPathBinding(filePath, after);
      await assertHeldDirectoryBindings(heldDirectories);
      return { path: filePath, sha256: knownDigest, metadata: after, bytes: undefined };
    }
    const bytes = await readBoundedFile(file, before, maxBytes);
    const after = await file.stat();
    if (fileChanged(before, after)) throw new Error("Function runtime file changed while reading");
    await assertPathBinding(filePath, after);
    await assertHeldDirectoryBindings(heldDirectories);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    rememberDigest(filePath, after, sha256);
    return { path: filePath, sha256, metadata: after, bytes };
  } finally {
    await file.close();
  }
}

async function readBoundFunctionFile(
  absolutePath: string,
  options: FunctionFileReadOptions,
): Promise<TrustedFunctionFileDigest> {
  const { maxBytes, withBytes = false } = options;
  const pathMetadata = await lstat(absolutePath);
  assertTrustedRegularFile(pathMetadata, false);
  const file = await openBoundFunctionFile(absolutePath);
  try {
    const before = await file.stat();
    assertTrustedRegularFile(before, false);
    if (!sameIdentity(pathMetadata, before)) {
      throw new Error("Function runtime file identity changed before read");
    }
    const knownDigest = withBytes ? null : lookupDigest(absolutePath, before);
    if (knownDigest !== null) {
      if (maxBytes !== undefined && before.size > maxBytes) {
        throw new Error("Function runtime file exceeds its byte limit");
      }
      const after = await file.stat();
      if (fileChanged(before, after)) throw new Error("Function runtime file changed while reading");
      await assertPathBinding(absolutePath, after);
      return { path: absolutePath, sha256: knownDigest, metadata: after, bytes: undefined };
    }
    const bytes = await readBoundedFile(file, before, maxBytes);
    const after = await file.stat();
    if (fileChanged(before, after)) throw new Error("Function runtime file changed while reading");
    await assertPathBinding(absolutePath, after);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    rememberDigest(absolutePath, after, sha256);
    return { path: absolutePath, sha256, metadata: after, bytes };
  } finally {
    await file.close();
  }
}

/**
 * Trusted read that returns the digest of the current file identity. When the
 * identity is already known, the contents are not read at all.
 */
export async function readFunctionFileDigest(
  filePath: string,
  options: FunctionFileReadOptions = {},
): Promise<TrustedFunctionFileDigest> {
  const absolutePath = resolve(filePath);
  if (process.platform !== "linux") return readBoundFunctionFile(absolutePath, options);
  const heldDirectories = await heldTrustedDirectoryChain(dirname(absolutePath));
  try {
    return await readHeldFunctionFile(absolutePath, heldDirectories, options);
  } finally {
    await closeHeldDirectories(heldDirectories);
  }
}

export async function readTrustedFunctionFile(filePath: string, maxBytes?: number): Promise<TrustedFunctionFile> {
  const absolutePath = resolve(filePath);
  const heldDirectories = await heldTrustedDirectoryChain(dirname(absolutePath));
  try {
    return materializeTrustedFunctionFile(
      await readHeldFunctionFile(absolutePath, heldDirectories, { maxBytes, withBytes: true }),
    );
  } finally {
    await closeHeldDirectories(heldDirectories);
  }
}

export async function readFunctionFile(filePath: string, maxBytes?: number): Promise<TrustedFunctionFile> {
  return materializeTrustedFunctionFile(await readFunctionFileDigest(filePath, { maxBytes, withBytes: true }));
}

function materializeTrustedFunctionFile(file: TrustedFunctionFileDigest): TrustedFunctionFile {
  if (file.bytes === undefined) throw new Error("Function runtime file bytes are unavailable");
  return { path: file.path, bytes: file.bytes, sha256: file.sha256, metadata: file.metadata };
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
    const imported = await readArtifact(absolutePath);
    const after = await artifact.stat();
    if (fileChanged(metadata, after)) throw new Error("Function runtime file changed while importing");
    await assertHeldDirectoryBindings(heldDirectories);
    return imported;
  } finally {
    await artifact?.close();
    await closeHeldDirectories(heldDirectories);
  }
}
