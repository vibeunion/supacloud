import { createHash, type Hash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { FRAMEWORK_DEFAULTS, type FrontendDeployment } from "../types/frontend";
import {
  extractVerifiedZip,
  verifiedZipArchive,
  type VerifiedZipArchive,
  type VerifiedZipFileEntry,
} from "./frontend-release-archive";
import {
  assertFrontendIdentity,
  assertReleaseId,
  FRONTEND_BASE_DIR,
  FRONTEND_RELEASE_ARCHIVE_MAX_BYTES,
  FRONTEND_RELEASE_LIST_MAX_LIMIT,
  FRONTEND_RELEASE_SCHEMA,
  RELEASE_ID_PATTERN,
  frontendReleaseError,
  frontendReleaseMutationPlatformSupported,
  nodeErrorCode,
  parseActiveRelease,
  parseReleaseRecord,
  type FrontendReleaseUploadSession,
  type FrontendActiveReleaseRecord,
  type FrontendReleaseInventory,
  type FrontendReleaseListPage,
  type FrontendReleaseRecord,
  type FrontendReleaseStoragePort,
  type VerifiedStagedFrontendArchive,
} from "./frontend-release-contract";

const FILE_HASH_CHUNK_BYTES = 64 * 1024;

interface TreeFile {
  path: string;
  size: number;
  sha256: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface OpenVerifiedFile {
  handle: Awaited<ReturnType<typeof open>>;
  identity: FileIdentity;
  sha256: string;
}

interface PreparedArchiveState {
  projectRef: string;
  deploymentId: string;
  expectedLength: number;
  stagingRoot: string;
  stagingRootBinding: OpenDirectoryBinding;
  stagingDir: string;
  stagingDirBinding: OpenDirectoryBinding;
  stagingDirIdentity: DirectoryIdentity;
  archiveHandle: Awaited<ReturnType<typeof open>>;
  archiveIdentity: FileIdentity | null;
  archivePath: string;
  hash: Hash;
  written: number;
  status: "open" | "finished" | "consuming" | "closed";
}

async function writeArchiveChunk(state: PreparedArchiveState, chunk: Uint8Array): Promise<void> {
  if (state.status !== "open") {
    throw frontendReleaseError("FRONTEND_RELEASE_UPLOAD_CLOSED", 409, "Frontend release upload is closed");
  }
  if (state.written + chunk.byteLength > state.expectedLength) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH",
      400,
      "Frontend release upload length does not match Content-Length",
    );
  }
  let chunkOffset = 0;
  while (chunkOffset < chunk.byteLength) {
    const written = await state.archiveHandle.write(
      chunk,
      chunkOffset,
      chunk.byteLength - chunkOffset,
      state.written + chunkOffset,
    );
    if (written.bytesWritten === 0) throw new Error("Frontend release staging write made no progress");
    chunkOffset += written.bytesWritten;
  }
  state.hash.update(chunk);
  state.written += chunk.byteLength;
}

async function finishArchiveUpload(
  state: PreparedArchiveState,
  expectedSha256: string,
): Promise<VerifiedStagedFrontendArchive> {
  if (state.status !== "open") {
    throw frontendReleaseError("FRONTEND_RELEASE_UPLOAD_CLOSED", 409, "Frontend release upload is closed");
  }
  if (state.written !== state.expectedLength) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH",
      400,
      "Frontend release upload length does not match Content-Length",
    );
  }
  if (!RELEASE_ID_PATTERN.test(expectedSha256)) {
    throw frontendReleaseError("FRONTEND_RELEASE_ARCHIVE_INVALID", 400, "Expected SHA-256 is invalid");
  }
  await state.archiveHandle.sync();
  state.archiveIdentity = fileIdentity(await state.archiveHandle.stat());
  const digest = state.hash.digest("hex");
  state.status = "finished";
  if (state.archiveIdentity.size !== state.expectedLength || digest !== expectedSha256) {
    throw frontendReleaseError(
      digest === expectedSha256 ? "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH" : "FRONTEND_RELEASE_SHA_MISMATCH",
      400,
      digest === expectedSha256
        ? "Frontend release upload length does not match Content-Length"
        : "Frontend release archive SHA-256 does not match the request",
    );
  }
  return Object.freeze({ size_bytes: state.expectedLength, sha256: digest });
}

interface FrontendReleaseStorageOptions {
  baseDir?: string;
  now?: () => Date;
  beforePublish?: (artifactDir: string, finalDir: string) => Promise<void> | void;
}

async function secureFileBytes(path: string): Promise<Uint8Array> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Expected a regular file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error("File identity changed while it was read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function fileIdentity(metadata: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>): FileIdentity {
  if (!metadata.isFile()) throw new Error("Expected a regular file");
  return {
    dev: Number(metadata.dev),
    ino: Number(metadata.ino),
    size: Number(metadata.size),
    mtimeMs: Number(metadata.mtimeMs),
    ctimeMs: Number(metadata.ctimeMs),
  };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function hashHeldFile(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize?: number,
): Promise<{ identity: FileIdentity; sha256: string }> {
  const before = fileIdentity(await handle.stat());
  if (expectedSize !== undefined && before.size !== expectedSize) {
    throw new Error("File size does not match its trusted descriptor");
  }
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES);
  let offset = 0;
  while (offset < before.size) {
    const length = Math.min(chunk.byteLength, before.size - offset);
    const read = await handle.read(chunk, 0, length, offset);
    if (read.bytesRead === 0) throw new Error("File ended while it was hashed");
    hash.update(chunk.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  const after = fileIdentity(await handle.stat());
  if (!sameFile(before, after)) throw new Error("File identity changed while it was hashed");
  return { identity: after, sha256: hash.digest("hex") };
}

async function openVerifiedFile(path: string, expectedSize?: number): Promise<OpenVerifiedFile> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return { handle, ...await hashHeldFile(handle, expectedSize) };
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

async function secureFileDigest(path: string): Promise<{ size: number; sha256: string }> {
  const verified = await openVerifiedFile(path);
  try {
    return { size: verified.identity.size, sha256: verified.sha256 };
  } finally {
    await verified.handle.close();
  }
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface OpenDirectoryBinding extends DirectoryIdentity {
  handle: Awaited<ReturnType<typeof open>>;
}

async function trustedDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path);
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()
    || ![0, effectiveUid].includes(metadata.uid) || (metadata.mode & 0o022) !== 0
    || await realpath(path) !== resolve(path)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
      500,
      "Frontend release storage is not trusted",
    );
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

async function openTrustedDirectory(path: string): Promise<OpenDirectoryBinding> {
  if (!frontendReleaseMutationPlatformSupported()) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_STORAGE_PLATFORM_UNSUPPORTED",
      503,
      "Immutable frontend release storage requires Linux directory binding",
    );
  }
  await assertTrustedDirectoryChain(path);
  const expected = await trustedDirectoryIdentity(path);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
        500,
        "Frontend release storage identity changed",
      );
    }
    return { handle, dev: metadata.dev, ino: metadata.ino };
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

function boundDirectoryPath(binding: OpenDirectoryBinding): string {
  return `/proc/self/fd/${binding.handle.fd}`;
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertDirectoryBinding(path: string, binding: OpenDirectoryBinding): Promise<void> {
  let current: DirectoryIdentity;
  try {
    current = await trustedDirectoryIdentity(path);
  } catch {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
      500,
      "Frontend release storage identity changed",
    );
  }
  if (!sameDirectory(binding, current)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
      500,
      "Frontend release storage identity changed",
    );
  }
}

function directEntryName(directory: string, path: string): string {
  const name = relative(directory, path);
  if (!name || name.includes("/") || name.includes("\\")) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
      500,
      "Frontend release path is invalid",
    );
  }
  return name;
}

async function pathIdentity(path: string, kind: "file" | "directory"): Promise<DirectoryIdentity> {
  const metadata = await lstat(path);
  const expectedType = kind === "file" ? metadata.isFile() : metadata.isDirectory();
  if (!expectedType || metadata.isSymbolicLink()) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
      500,
      "Frontend release path type is invalid",
    );
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

async function assertBoundEntry(
  directory: string,
  binding: OpenDirectoryBinding,
  name: string,
  expected: DirectoryIdentity,
  kind: "file" | "directory",
): Promise<void> {
  await assertDirectoryBinding(directory, binding);
  const boundIdentity = await pathIdentity(join(boundDirectoryPath(binding), name), kind);
  const requestedIdentity = await pathIdentity(join(directory, name), kind);
  if (!sameDirectory(expected, boundIdentity) || !sameDirectory(expected, requestedIdentity)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
      500,
      "Frontend release path identity changed",
    );
  }
}

async function assertTrustedDirectoryChain(path: string): Promise<void> {
  const canonicalPath = await realpath(path).catch(() => "");
  const resolvedPath = resolve(path);
  if (!canonicalPath || canonicalPath !== resolvedPath) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
      500,
      "Frontend release storage is not trusted",
    );
  }
  const segments = relative("/", resolvedPath).split("/").filter(Boolean);
  let current = "/";
  await trustedDirectoryIdentity(current);
  for (const segment of segments) {
    current = join(current, segment);
    await trustedDirectoryIdentity(current);
  }
}

async function treeFiles(root: string, requireReadOnly = false): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (entry.isDirectory()) {
        if (metadata.isSymbolicLink() || (requireReadOnly && (metadata.mode & 0o222) !== 0)) {
          throw frontendReleaseError(
            "FRONTEND_RELEASE_STORAGE_INVALID",
            500,
            "Frontend release directory permissions are invalid",
          );
        }
        await walk(absolutePath);
      } else if (entry.isFile()) {
        if (metadata.isSymbolicLink() || (requireReadOnly && (metadata.mode & 0o222) !== 0)) {
          throw frontendReleaseError(
            "FRONTEND_RELEASE_STORAGE_INVALID",
            500,
            "Frontend release file permissions are invalid",
          );
        }
        const filePath = relative(root, absolutePath).split("\\").join("/");
        const digest = await secureFileDigest(absolutePath);
        files.push({ path: filePath, size: digest.size, sha256: digest.sha256 });
      } else {
        throw frontendReleaseError(
          "FRONTEND_RELEASE_STORAGE_INVALID",
          500,
          "Frontend release contains a non-regular file",
        );
      }
    }
  };
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function treeSha256(files: readonly TreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const frame = Buffer.alloc(12);
    frame.writeUInt32BE(pathBytes.byteLength, 0);
    frame.writeBigUInt64BE(BigInt(file.size), 4);
    hash.update(frame).update(pathBytes).update(Buffer.from(file.sha256, "hex"));
  }
  return hash.digest("hex");
}

async function verifiedTree(
  buildDir: string,
  zipEntries: readonly VerifiedZipFileEntry[],
  requireReadOnly = false,
): Promise<TreeFile[]> {
  if (await realpath(buildDir) !== resolve(buildDir)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_ARCHIVE_INVALID",
      400,
      "Extracted release path is invalid",
    );
  }
  const files = await treeFiles(buildDir, requireReadOnly);
  const expected = new Map(zipEntries.map((entry) => [entry.path, entry.uncompressedSize]));
  if (files.length !== expected.size || files.some((file) => expected.get(file.path) !== file.size)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_ARCHIVE_INVALID",
      400,
      "Extracted release does not match its zip inventory",
    );
  }
  return files;
}

async function freezeTree(root: string, freezeRoot = true): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await freezeTree(path);
      await chmod(path, 0o555);
    } else if (entry.isFile()) {
      await chmod(path, 0o444);
    } else {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_INVALID",
        500,
        "Frontend release contains a non-regular file",
      );
    }
  }
  if (freezeRoot) await chmod(root, 0o555);
}

async function makeTreeRemovable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    await chmod(directory, 0o700).catch(() => undefined);
    await makeTreeRemovable(directory);
  }
}

async function writeBoundFile(path: string, contents: string): Promise<DirectoryIdentity> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o444,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
        500,
        "Frontend release path type is invalid",
      );
    }
    return { dev: metadata.dev, ino: metadata.ino };
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

async function removeBoundFile(directory: string, path: string): Promise<void> {
  const name = directEntryName(directory, path);
  const binding = await openTrustedDirectory(directory);
  try {
    await unlinkIfPresent(join(boundDirectoryPath(binding), name));
    await binding.handle.sync();
    await assertDirectoryBinding(directory, binding);
    const requested = await lstat(path).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (requested !== null) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
        500,
        "Frontend release path was not removed",
      );
    }
  } finally {
    await binding.handle.close();
  }
}

async function writeFileAtomic(directory: string, path: string, contents: string): Promise<void> {
  const requestedName = directEntryName(directory, path);
  const binding = await openTrustedDirectory(directory);
  const temporaryName = `.frontend-release-${crypto.randomUUID()}.tmp`;
  const temporaryPath = join(boundDirectoryPath(binding), temporaryName);
  let renamed = false;
  try {
    const writtenIdentity = await writeBoundFile(temporaryPath, contents);
    await assertDirectoryBinding(directory, binding);
    await rename(temporaryPath, join(boundDirectoryPath(binding), requestedName));
    renamed = true;
    await binding.handle.sync();
    await assertBoundEntry(directory, binding, requestedName, writtenIdentity, "file");
  } catch (error: unknown) {
    if (!renamed) await unlinkIfPresent(temporaryPath);
    throw error;
  } finally {
    await binding.handle.close();
  }
}

interface ImmutableDirectoryPublish {
  sourceDir: string;
  finalDir: string;
  beforePublish?: (sourceDir: string, finalDir: string) => Promise<void> | void;
}

async function removeBoundDirectory(path: string): Promise<void> {
  await chmod(path, 0o700).catch(() => undefined);
  await makeTreeRemovable(path);
  await rm(path, { recursive: true, force: true });
}

async function publishImmutableDirectory(input: ImmutableDirectoryPublish): Promise<"published" | "exists"> {
  const destinationParent = dirname(input.finalDir);
  const destination = await openTrustedDirectory(destinationParent);
  let source: OpenDirectoryBinding | undefined;
  let published = false;
  try {
    const sourceParent = dirname(input.sourceDir);
    source = await openTrustedDirectory(sourceParent);
    const sourceName = directEntryName(sourceParent, input.sourceDir);
    const destinationName = directEntryName(destinationParent, input.finalDir);
    const artifactIdentity = await pathIdentity(join(boundDirectoryPath(source), sourceName), "directory");
    await input.beforePublish?.(input.sourceDir, input.finalDir);
    await assertBoundEntry(sourceParent, source, sourceName, artifactIdentity, "directory");
    await assertDirectoryBinding(destinationParent, destination);
    try {
      await rename(
        join(boundDirectoryPath(source), sourceName),
        join(boundDirectoryPath(destination), destinationName),
      );
    } catch (error: unknown) {
      if (["EEXIST", "ENOTEMPTY"].includes(nodeErrorCode(error))) {
        await assertDirectoryBinding(destinationParent, destination);
        return "exists";
      }
      throw error;
    }
    published = true;
    const boundFinalDir = join(boundDirectoryPath(destination), destinationName);
    await chmod(boundFinalDir, 0o555);
    await destination.handle.sync();
    await assertBoundEntry(destinationParent, destination, destinationName, artifactIdentity, "directory");
    return "published";
  } catch (error: unknown) {
    if (published) {
      await removeBoundDirectory(join(boundDirectoryPath(destination), basename(input.finalDir)))
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await source?.handle.close();
    await destination.handle.close();
  }
}

export class FrontendReleaseStorage implements FrontendReleaseStoragePort {
  private readonly baseDir: string;
  private readonly now: () => Date;
  private readonly beforePublish?: FrontendReleaseStorageOptions["beforePublish"];
  private readonly stagedArchives = new WeakMap<VerifiedStagedFrontendArchive, PreparedArchiveState>();

  constructor(options: FrontendReleaseStorageOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? FRONTEND_BASE_DIR);
    this.now = options.now ?? (() => new Date());
    this.beforePublish = options.beforePublish;
  }

  private deploymentDir(projectRef: string, deploymentId: string): string {
    return join(this.baseDir, projectRef, deploymentId);
  }

  private releasesDir(projectRef: string, deploymentId: string): string {
    return join(this.deploymentDir(projectRef, deploymentId), "releases");
  }

  private releaseDir(projectRef: string, deploymentId: string, releaseId: string): string {
    return join(this.releasesDir(projectRef, deploymentId), releaseId);
  }

  private activePath(projectRef: string, deploymentId: string): string {
    return join(this.deploymentDir(projectRef, deploymentId), "active-release.json");
  }

  releaseBuildDir(projectRef: string, deploymentId: string, releaseId: string): string {
    return join(this.releaseDir(projectRef, deploymentId, releaseId), "build");
  }

  legacyBuildDir(projectRef: string, deploymentId: string): string {
    return join(this.deploymentDir(projectRef, deploymentId), "build");
  }

  async assertMutationSupported(projectRef: string, deploymentId: string): Promise<void> {
    await this.deployment(projectRef, deploymentId);
    const binding = await openTrustedDirectory(this.deploymentDir(projectRef, deploymentId));
    await binding.handle.close();
  }

  async deployment(projectRef: string, deploymentId: string): Promise<FrontendDeployment> {
    assertFrontendIdentity(projectRef, deploymentId);
    await assertTrustedDirectoryChain(this.baseDir);
    await trustedDirectoryIdentity(join(this.baseDir, projectRef));
    await trustedDirectoryIdentity(this.deploymentDir(projectRef, deploymentId));
    let candidate: unknown;
    try {
      candidate = JSON.parse(new TextDecoder().decode(
        await secureFileBytes(join(this.deploymentDir(projectRef, deploymentId), "deployment.json")),
      ));
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") {
        throw frontendReleaseError(
          "FRONTEND_RELEASE_DEPLOYMENT_NOT_FOUND",
          404,
          "Frontend deployment not found",
        );
      }
      throw error;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_DEPLOYMENT_INVALID",
        500,
        "Frontend deployment metadata is invalid",
      );
    }
    const deployment = candidate as FrontendDeployment;
    const defaults = FRAMEWORK_DEFAULTS[deployment.framework];
    if (deployment.project_ref !== projectRef || deployment.id !== deploymentId || !defaults) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_DEPLOYMENT_INVALID",
        500,
        "Frontend deployment metadata is invalid",
      );
    }
    if (defaults.is_ssr) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_SSR_UNSUPPORTED",
        409,
        "Immutable frontend releases support prebuilt static deployments only",
      );
    }
    return deployment;
  }

  private async stagingRoot(projectRef: string, deploymentId: string): Promise<string> {
    await assertTrustedDirectoryChain(this.baseDir);
    await trustedDirectoryIdentity(join(this.baseDir, projectRef));
    await trustedDirectoryIdentity(this.deploymentDir(projectRef, deploymentId));
    const releasesDir = this.releasesDir(projectRef, deploymentId);
    await this.ensurePrivateDirectory(releasesDir);
    const stagingRoot = join(releasesDir, ".staging");
    await this.ensurePrivateDirectory(stagingRoot);
    return stagingRoot;
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error: unknown) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
    const binding = await openTrustedDirectory(path);
    try {
      await binding.handle.chmod(0o700);
      await binding.handle.sync();
      const metadata = await binding.handle.stat();
      if ((metadata.mode & 0o777) !== 0o700) {
        throw frontendReleaseError(
          "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
          500,
          "Frontend release staging permissions are invalid",
        );
      }
      await assertDirectoryBinding(path, binding);
    } finally {
      await binding.handle.close();
    }
  }

  async prepareReleaseUpload(
    projectRef: string,
    deploymentId: string,
    expectedLength: number,
  ): Promise<FrontendReleaseUploadSession> {
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 1
      || expectedLength > FRONTEND_RELEASE_ARCHIVE_MAX_BYTES) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_ARCHIVE_TOO_LARGE",
        413,
        `Frontend release archive exceeds ${FRONTEND_RELEASE_ARCHIVE_MAX_BYTES} bytes`,
      );
    }
    await this.assertMutationSupported(projectRef, deploymentId);
    const stagingRoot = await this.stagingRoot(projectRef, deploymentId);
    const stagingRootBinding = await openTrustedDirectory(stagingRoot);
    let stagingDirBinding: OpenDirectoryBinding | undefined;
    let archiveHandle: Awaited<ReturnType<typeof open>> | undefined;
    let stagingDir = "";
    try {
      const boundStagingDir = await mkdtemp(join(boundDirectoryPath(stagingRootBinding), "upload-"));
      const stagingDirName = basename(boundStagingDir);
      stagingDir = join(stagingRoot, stagingDirName);
      await chmod(boundStagingDir, 0o700);
      const stagingDirIdentity = await pathIdentity(boundStagingDir, "directory");
      stagingDirBinding = await openTrustedDirectory(stagingDir);
      await assertBoundEntry(stagingRoot, stagingRootBinding, stagingDirName, stagingDirIdentity, "directory");
      const archivePath = join(boundDirectoryPath(stagingDirBinding), "archive.zip");
      archiveHandle = await open(
        archivePath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const state: PreparedArchiveState = {
        projectRef,
        deploymentId,
        expectedLength,
        stagingRoot,
        stagingRootBinding,
        stagingDir,
        stagingDirBinding,
        stagingDirIdentity,
        archiveHandle,
        archiveIdentity: null,
        archivePath,
        hash: createHash("sha256"),
        written: 0,
        status: "open",
      };
      return this.uploadSession(state);
    } catch (error: unknown) {
      await archiveHandle?.close().catch(() => undefined);
      await stagingDirBinding?.handle.close().catch(() => undefined);
      if (stagingDir) await removeBoundDirectory(stagingDir).catch(() => undefined);
      await stagingRootBinding.handle.close();
      throw error;
    }
  }

  private uploadSession(state: PreparedArchiveState): FrontendReleaseUploadSession {
    return Object.freeze({
      write: (chunk: Uint8Array) => writeArchiveChunk(state, chunk),
      finish: async (expectedSha256: string) => {
        const descriptor = await finishArchiveUpload(state, expectedSha256);
        this.stagedArchives.set(descriptor, state);
        return descriptor;
      },
      abort: () => this.abortPreparedUpload(state),
    });
  }

  private async abortPreparedUpload(state: PreparedArchiveState): Promise<void> {
    if (state.status === "closed" || state.status === "consuming") return;
    state.status = "closed";
    await state.archiveHandle.close().catch(() => undefined);
    await this.removePreparedUpload(state);
  }

  private async removePreparedUpload(state: PreparedArchiveState): Promise<void> {
    try {
      await this.clearPreparedUploadContents(state);
      await assertBoundEntry(
        state.stagingRoot,
        state.stagingRootBinding,
        basename(state.stagingDir),
        state.stagingDirIdentity,
        "directory",
      );
      await rmdir(join(
        boundDirectoryPath(state.stagingRootBinding),
        basename(state.stagingDir),
      ));
      await state.stagingRootBinding.handle.sync();
      await assertDirectoryBinding(state.stagingRoot, state.stagingRootBinding);
    } finally {
      await state.stagingDirBinding.handle.close().catch(() => undefined);
      await state.stagingRootBinding.handle.close().catch(() => undefined);
    }
  }

  private async clearPreparedUploadContents(state: PreparedArchiveState): Promise<void> {
    const boundStagingDir = boundDirectoryPath(state.stagingDirBinding);
    const entries = await readdir(boundStagingDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(boundStagingDir, entry.name);
      if (entry.isDirectory()) {
        await removeBoundDirectory(entryPath);
      } else {
        await unlink(entryPath);
      }
    }
    await state.stagingDirBinding.handle.sync();
  }

  async releaseRecord(
    projectRef: string,
    deploymentId: string,
    releaseId: string,
  ): Promise<FrontendReleaseRecord> {
    assertReleaseId(releaseId);
    const releaseDir = this.releaseDir(projectRef, deploymentId, releaseId);
    const directory = await lstat(releaseDir).catch(() => null);
    if (!directory?.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o222) !== 0
      || await realpath(releaseDir).catch(() => "") !== releaseDir) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_NOT_FOUND",
        404,
        "Frontend release not found or invalid",
      );
    }
    const metadata = parseReleaseRecord(JSON.parse(new TextDecoder().decode(
      await secureFileBytes(join(releaseDir, "release.json")),
    )));
    if (metadata.project_ref !== projectRef || metadata.deployment_id !== deploymentId
      || metadata.release_id !== releaseId) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_INVALID",
        500,
        "Frontend release identity does not match its storage path",
      );
    }
    const archive = await openVerifiedFile(join(releaseDir, "archive.zip"), metadata.size_bytes);
    let zip: VerifiedZipArchive;
    try {
      if (archive.sha256 !== metadata.sha256) {
        throw frontendReleaseError(
          "FRONTEND_RELEASE_STORAGE_INVALID",
          500,
          "Frontend release archive verification failed",
        );
      }
      zip = await verifiedZipArchive(archive.handle, metadata.size_bytes);
    } finally {
      await archive.handle.close();
    }
    const files = await verifiedTree(join(releaseDir, "build"), zip.entries, true);
    if (files.length !== metadata.file_count || treeSha256(files) !== metadata.tree_sha256) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_INVALID",
        500,
        "Frontend release integrity verification failed",
      );
    }
    return metadata;
  }

  async activeRelease(
    projectRef: string,
    deploymentId: string,
  ): Promise<FrontendActiveReleaseRecord | null> {
    let bytes: Uint8Array;
    try {
      bytes = await secureFileBytes(this.activePath(projectRef, deploymentId));
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
    const active = parseActiveRelease(JSON.parse(new TextDecoder().decode(bytes)));
    if (active.project_ref !== projectRef || active.deployment_id !== deploymentId) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_AUTHORITY_INVALID",
        500,
        "Frontend active release identity is invalid",
      );
    }
    const release = await this.releaseRecord(projectRef, deploymentId, active.release_id);
    if (release.sha256 !== active.sha256 || release.tree_sha256 !== active.tree_sha256) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_AUTHORITY_INVALID",
        500,
        "Frontend active release does not match its immutable artifact",
      );
    }
    return active;
  }

  async writeActiveRelease(
    projectRef: string,
    deploymentId: string,
    record: FrontendActiveReleaseRecord | null,
  ): Promise<void> {
    const directory = this.deploymentDir(projectRef, deploymentId);
    await trustedDirectoryIdentity(directory);
    const path = this.activePath(projectRef, deploymentId);
    if (!record) {
      await removeBoundFile(directory, path);
      return;
    }
    await writeFileAtomic(directory, path, `${JSON.stringify(record)}\n`);
  }

  async compareAndSwapActiveRelease(
    projectRef: string,
    deploymentId: string,
    expectedReleaseId: "absent" | string,
    expectedActivationId: "absent" | string,
    record: FrontendActiveReleaseRecord | null,
  ): Promise<"updated" | "conflict"> {
    const current = await this.activeRelease(projectRef, deploymentId);
    if ((current?.release_id ?? "absent") !== expectedReleaseId
      || (current?.activation_id ?? "absent") !== expectedActivationId) return "conflict";
    await this.writeActiveRelease(projectRef, deploymentId, record);
    const readBack = await this.activeRelease(projectRef, deploymentId);
    if ((readBack?.release_id ?? "absent") !== (record?.release_id ?? "absent")
      || (readBack?.activation_id ?? "absent") !== (record?.activation_id ?? "absent")) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_AUTHORITY_INVALID",
        500,
        "Frontend active release authority read-back failed",
      );
    }
    return "updated";
  }

  async activeBuildDir(projectRef: string, deploymentId: string): Promise<string | null> {
    assertFrontendIdentity(projectRef, deploymentId);
    try {
      await lstat(this.activePath(projectRef, deploymentId));
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
    await this.deployment(projectRef, deploymentId);
    const active = await this.activeRelease(projectRef, deploymentId);
    return active ? this.releaseBuildDir(projectRef, deploymentId, active.release_id) : null;
  }

  async hasActiveRelease(projectRef: string, deploymentId: string): Promise<boolean> {
    assertFrontendIdentity(projectRef, deploymentId);
    try {
      await lstat(this.activePath(projectRef, deploymentId));
      return true;
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async createRelease(
    projectRef: string,
    deploymentId: string,
    archive: VerifiedStagedFrontendArchive,
  ): Promise<FrontendReleaseRecord> {
    const state = this.stagedArchives.get(archive);
    if (!state || state.status !== "finished" || state.projectRef !== projectRef
      || state.deploymentId !== deploymentId || state.archiveIdentity === null
      || archive.size_bytes !== state.expectedLength || archive.sha256.length !== 64) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_ARCHIVE_INVALID",
        400,
        "Frontend release staged archive is invalid or already consumed",
      );
    }
    state.status = "consuming";
    this.stagedArchives.delete(archive);
    try {
      await this.assertPreparedArchive(state);
      return await this.publishRelease(state, archive.sha256);
    } finally {
      await state.archiveHandle.close().catch(() => undefined);
      state.status = "closed";
      await this.removePreparedUpload(state);
    }
  }

  private async assertPreparedArchive(state: PreparedArchiveState): Promise<void> {
    await assertBoundEntry(
      state.stagingRoot,
      state.stagingRootBinding,
      basename(state.stagingDir),
      state.stagingDirIdentity,
      "directory",
    );
    const current = fileIdentity(await state.archiveHandle.stat());
    if (!state.archiveIdentity || !sameFile(state.archiveIdentity, current)
      || current.size !== state.expectedLength) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
        500,
        "Frontend release staged archive identity changed",
      );
    }
    const requested = await pathIdentity(join(state.stagingDir, "archive.zip"), "file");
    if (requested.dev !== current.dev || requested.ino !== current.ino) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_UNTRUSTED",
        500,
        "Frontend release staged archive path changed",
      );
    }
  }

  private async publishRelease(
    state: PreparedArchiveState,
    releaseId: string,
  ): Promise<FrontendReleaseRecord> {
    const zip = await verifiedZipArchive(state.archiveHandle, state.expectedLength);
    return this.publishStagingRelease({ state, releaseId, zip });
  }

  private async publishStagingRelease(input: {
    state: PreparedArchiveState;
    releaseId: string;
    zip: VerifiedZipArchive;
  }): Promise<FrontendReleaseRecord> {
    const artifactDir = join(input.state.stagingDir, "artifact");
    const archivePath = join(artifactDir, "archive.zip");
    const buildDir = join(artifactDir, "build");
    await mkdir(artifactDir, { mode: 0o700 });
    await mkdir(buildDir, { mode: 0o700 });
    await extractVerifiedZip(input.state.archiveHandle, input.zip, buildDir);
    await rename(input.state.archivePath, archivePath);
    await input.state.stagingDirBinding.handle.sync();
    const files = await verifiedTree(buildDir, input.zip.entries);
    const record: FrontendReleaseRecord = {
      schema: FRONTEND_RELEASE_SCHEMA,
      project_ref: input.state.projectRef,
      deployment_id: input.state.deploymentId,
      release_id: input.releaseId,
      sha256: input.releaseId,
      tree_sha256: treeSha256(files),
      size_bytes: input.state.expectedLength,
      file_count: files.length,
      created_at: this.now().toISOString(),
      kind: "prebuilt_static",
    };
    await writeFileAtomic(artifactDir, join(artifactDir, "release.json"), `${JSON.stringify(record)}\n`);
    await freezeTree(artifactDir, false);
    return this.commitStagingRelease({
      projectRef: input.state.projectRef,
      deploymentId: input.state.deploymentId,
      releaseId: input.releaseId,
      artifactDir,
    }, record);
  }

  private async commitStagingRelease(
    input: { projectRef: string; deploymentId: string; releaseId: string; artifactDir: string },
    record: FrontendReleaseRecord,
  ): Promise<FrontendReleaseRecord> {
    const finalDir = this.releaseDir(input.projectRef, input.deploymentId, input.releaseId);
    const publish = await publishImmutableDirectory({
      sourceDir: input.artifactDir,
      finalDir,
      beforePublish: this.beforePublish,
    });
    if (publish === "exists") {
      return this.releaseRecord(input.projectRef, input.deploymentId, input.releaseId);
    }
    const readBack = await this.releaseRecord(input.projectRef, input.deploymentId, input.releaseId);
    if (readBack.tree_sha256 !== record.tree_sha256) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_INVALID",
        500,
        "Frontend release publish read-back failed",
      );
    }
    return readBack;
  }

  async listReleases(
    projectRef: string,
    deploymentId: string,
    page: FrontendReleaseListPage,
  ): Promise<FrontendReleaseInventory> {
    await this.deployment(projectRef, deploymentId);
    if (!Number.isSafeInteger(page.limit) || page.limit < 1
      || page.limit > FRONTEND_RELEASE_LIST_MAX_LIMIT
      || (page.cursor !== undefined && !RELEASE_ID_PATTERN.test(page.cursor))) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_PAGE_INVALID",
        400,
        `Frontend release page limit must be 1-${FRONTEND_RELEASE_LIST_MAX_LIMIT}`,
      );
    }
    const entries = await readdir(this.releasesDir(projectRef, deploymentId), { withFileTypes: true })
      .catch((error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") return [];
        throw error;
      });
    const releaseIds = entries.filter((entry) => entry.name !== ".staging").map((entry) => {
      if (!entry.isDirectory() || !RELEASE_ID_PATTERN.test(entry.name)) {
        throw frontendReleaseError(
          "FRONTEND_RELEASE_STORAGE_INVALID",
          500,
          "Frontend release inventory contains an invalid entry",
        );
      }
      return entry.name;
    }).sort();
    const start = page.cursor === undefined
      ? 0
      : releaseIds.findIndex((releaseId) => releaseId > page.cursor!);
    const pageIds = start < 0 ? [] : releaseIds.slice(start, start + page.limit + 1);
    const hasMore = pageIds.length > page.limit;
    const selectedIds = hasMore ? pageIds.slice(0, page.limit) : pageIds;
    const releases: FrontendReleaseRecord[] = [];
    for (const releaseId of selectedIds) {
      releases.push(await this.releaseRecord(projectRef, deploymentId, releaseId));
    }
    const active = await this.activeRelease(projectRef, deploymentId);
    return {
      project_ref: projectRef,
      deployment_id: deploymentId,
      active_release_id: active?.release_id ?? null,
      active_activation_id: active?.activation_id ?? null,
      releases,
      next_cursor: hasMore ? selectedIds.at(-1)! : null,
    };
  }
}
