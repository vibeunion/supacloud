import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { config } from "../config";
import { projectRepository } from "../repositories/project.repository";
import { isKnownRegion } from "../regions";
import {
  copyVerifiedLogicalBackupArchive,
  LogicalBackupContractError,
  readLogicalBackup,
} from "./logical-backup.service";
import type { LogicalBackupIdentity } from "../types/backup";
import { logger } from "../utils/logger";
import { stableStringify } from "../utils/stable-json";

export const REGION_SHIP_SCHEMA = "supacloud.region-ship.v1" as const;
export const REGION_SHIP_TRANSPORT = "loopback" as const;
export const REGION_SHIP_TARGET_APPLY = "not executed" as const;

const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_ID_PATTERN = /^logical-full_[A-Za-z0-9_-]{1,64}_[a-f0-9]{32}$/;
const BACKUP_ID_SUFFIX_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATABASE_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/;
const RECEIPT_KEYS = [
  "schema",
  "project_ref",
  "backup_id",
  "database",
  "source_region",
  "target_region",
  "bytes",
  "sha256",
  "shipped_at",
  "transport",
  "target_apply",
  "receipt_hmac_sha256",
] as const;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const FILE_CREATE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW;
const MAX_RECEIPT_BYTES = 8 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;

type RegionShipErrorKind = "invalid_request" | "not_found" | "conflict" | "unavailable";

export interface RegionShipRecord {
  schema: typeof REGION_SHIP_SCHEMA;
  project_ref: string;
  backup_id: string;
  database: string;
  source_region: string;
  target_region: string;
  bytes: number;
  sha256: string;
  shipped_at: string;
  transport: typeof REGION_SHIP_TRANSPORT;
  target_apply: typeof REGION_SHIP_TARGET_APPLY;
}

type RegionShipReceipt = RegionShipRecord & { receipt_hmac_sha256: string };
type UnsignedRegionShipReceipt = RegionShipRecord;

export class RegionShipError extends Error {
  constructor(
    readonly kind: RegionShipErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RegionShipError";
  }
}

function invalidRequest(message: string): RegionShipError {
  return new RegionShipError("invalid_request", message);
}

function notFound(message: string): RegionShipError {
  return new RegionShipError("not_found", message);
}

function conflict(message: string): RegionShipError {
  return new RegionShipError("conflict", message);
}

function unavailable(message: string, cause?: unknown): RegionShipError {
  logger.error("[RegionShip] unavailable", {
    cause: cause instanceof Error ? cause.name : "UnknownError",
  });
  return new RegionShipError("unavailable", message, cause === undefined ? undefined : { cause });
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function belongsToProject(backupId: string, projectRef: string): boolean {
  const projectPrefix = `logical-full_${projectRef}_`;
  return BACKUP_ID_PATTERN.test(backupId)
    && backupId.startsWith(projectPrefix)
    && BACKUP_ID_SUFFIX_PATTERN.test(backupId.slice(projectPrefix.length));
}

function assertShipIdentity(projectRef: string, backupId: string, targetRegion: string): void {
  if (!PROJECT_REF_PATTERN.test(projectRef) || !belongsToProject(backupId, projectRef)) {
    throw invalidRequest("Invalid region ship identity");
  }
  if (!isKnownRegion(targetRegion)) throw invalidRequest("Unknown target region");
}

function projectRegion(region: string | null | undefined): string {
  const value = region?.trim() || "local";
  if (!isKnownRegion(value)) throw invalidRequest("Project region is not in the region catalog");
  return value;
}

function assertRegionPair(sourceRegion: string, targetRegion: string): void {
  if (sourceRegion === targetRegion) {
    throw invalidRequest("Target region matches the project region");
  }
}

function regionShipRootPath(): string {
  return resolve(process.env["SUPACLOUD_REGION_SHIP_DIR"] || "/var/lib/supacloud/region-ship");
}

function canonicalDirectoryChain(directoryPath: string): string[] {
  if (resolve(directoryPath) !== directoryPath) {
    throw new Error("Region ship directory path is not canonical");
  }
  const filesystemRoot = parsePath(directoryPath).root;
  const pathSegments = relative(filesystemRoot, directoryPath).split(sep).filter(Boolean);
  const chain = [filesystemRoot];
  for (const pathSegment of pathSegments) chain.push(join(chain.at(-1)!, pathSegment));
  return chain;
}

function assertTrustedDirectory(metadata: Stats): void {
  const effectiveUid = process.geteuid?.();
  const trustedOwner = effectiveUid !== undefined
    && (metadata.uid === 0 || metadata.uid === effectiveUid);
  if (!metadata.isDirectory() || !trustedOwner || (metadata.mode & 0o022) !== 0) {
    throw new Error("Region ship directory is not trusted");
  }
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return sameInode(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function openTrustedDirectory(directoryPath: string): Promise<FileHandle> {
  const pathMetadata = await lstat(directoryPath);
  assertTrustedDirectory(pathMetadata);
  const directory = await open(directoryPath, DIRECTORY_OPEN_FLAGS);
  try {
    const descriptorMetadata = await directory.stat();
    assertTrustedDirectory(descriptorMetadata);
    if (sameInode(pathMetadata, descriptorMetadata)) return directory;
    throw new Error("Region ship directory identity changed");
  } catch (error: unknown) {
    await directory.close();
    throw error;
  }
}

function trustedChildPath(parent: FileHandle, childName: string): string {
  if (childName !== basename(childName) || childName === "" || childName === "." || childName === "..") {
    throw new Error("Invalid region ship directory name");
  }
  return process.platform === "linux"
    ? `/proc/self/fd/${parent.fd}/${childName}`
    : join(regionShipRootPath(), childName);
}

async function openMode700Directory(directoryPath: string): Promise<FileHandle> {
  const directory = await openTrustedDirectory(directoryPath);
  try {
    const metadata = await directory.stat();
    if ((metadata.mode & 0o777) === 0o700) return directory;
    throw new Error("Region ship directory must use mode 0700");
  } catch (error: unknown) {
    await directory.close();
    throw error;
  }
}

async function openOrCreateMode700Directory(directoryPath: string): Promise<FileHandle> {
  try {
    return await openMode700Directory(directoryPath);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
  }
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isExistingPathError(error)) throw error;
  }
  await chmod(directoryPath, 0o700);
  return openMode700Directory(directoryPath);
}

async function openParentDirectory(directoryPath: string, create: boolean): Promise<FileHandle> {
  try {
    return await openTrustedDirectory(directoryPath);
  } catch (error: unknown) {
    if (!create || !isMissingPathError(error)) throw error;
  }
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isExistingPathError(error)) throw error;
    return openTrustedDirectory(directoryPath);
  }
  await chmod(directoryPath, 0o700);
  return openTrustedDirectory(directoryPath);
}

async function openShipRoot(create: boolean): Promise<FileHandle> {
  const [filesystemRoot, ...pathEntries] = canonicalDirectoryChain(regionShipRootPath());
  if (pathEntries.length === 0) throw new Error("Region ship directory must use mode 0700");
  let trustedDirectory = await openTrustedDirectory(filesystemRoot!);
  try {
    for (let index = 0; index < pathEntries.length; index += 1) {
      const isLeaf = index === pathEntries.length - 1;
      const childPath = trustedChildPath(trustedDirectory, basename(pathEntries[index]!));
      const nextDirectory = isLeaf
        ? create
          ? await openOrCreateMode700Directory(childPath)
          : await openMode700Directory(childPath)
        : await openParentDirectory(childPath, create);
      try {
        if (create && isLeaf) await trustedDirectory.sync();
        await trustedDirectory.close();
      } catch (error: unknown) {
        await nextDirectory.close();
        throw error;
      }
      trustedDirectory = nextDirectory;
    }
    return trustedDirectory;
  } catch (error: unknown) {
    await trustedDirectory.close();
    throw error;
  }
}

function childFilePath(directory: FileHandle, filename: string): string {
  if (filename !== basename(filename)) throw new Error("Invalid region ship filename");
  return process.platform === "linux"
    ? `/proc/self/fd/${directory.fd}/${filename}`
    : join(regionShipRootPath(), filename);
}

function archiveName(backupId: string): string {
  return `${backupId}.dump`;
}

function partialName(backupId: string): string {
  return `.${backupId}.dump.partial`;
}

function receiptName(backupId: string): string {
  return `${backupId}.json`;
}

function assertPrivateFile(metadata: Stats): void {
  const effectiveUid = process.geteuid?.();
  const trustedOwner = effectiveUid !== undefined
    && (metadata.uid === 0 || metadata.uid === effectiveUid);
  if (!metadata.isFile()
    || !trustedOwner
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size <= 0) {
    throw new Error("Region ship file identity is invalid");
  }
}

async function optionalMetadata(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error: unknown) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function hashOpenFile(file: FileHandle, bytes: number): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, bytes));
  let position = 0;
  while (position < bytes) {
    const requestedBytes = Math.min(buffer.length, bytes - position);
    const { bytesRead } = await file.read(buffer, 0, requestedBytes, position);
    if (bytesRead === 0) throw new Error("Region ship archive ended during hashing");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

async function hashPrivateFile(
  directory: FileHandle,
  filename: string,
): Promise<{ bytes: number; sha256: string }> {
  const path = childFilePath(directory, filename);
  const pathMetadata = await lstat(path);
  assertPrivateFile(pathMetadata);
  const file = await open(path, FILE_READ_FLAGS);
  try {
    const metadata = await file.stat();
    assertPrivateFile(metadata);
    if (!sameInode(pathMetadata, metadata)) throw new Error("Region ship file changed");
    const sha256 = await hashOpenFile(file, metadata.size);
    if (!sameFileVersion(metadata, await file.stat()) || !sameInode(metadata, await lstat(path))) {
      throw new Error("Region ship file changed during hashing");
    }
    return { bytes: metadata.size, sha256 };
  } finally {
    await file.close();
  }
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && sortedExpected.every((key, index) => actual[index] === key);
}

function isPlainRecord(candidate: unknown): candidate is Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const prototype = Object.getPrototypeOf(candidate);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalTimestamp(candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false;
  const timestamp = new Date(candidate);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === candidate;
}

function receiptHmac(receipt: UnsignedRegionShipReceipt, signingKey: string): string {
  if (signingKey.length < 32) throw new Error("Region ship receipt signing key is unavailable");
  return createHmac("sha256", signingKey).update(stableStringify(receipt)).digest("hex");
}

function assertReceiptSignature(receipt: RegionShipReceipt): void {
  const { receipt_hmac_sha256: signature, ...unsignedReceipt } = receipt;
  if (!SHA256_PATTERN.test(signature) || config.secretsEncryptionKey.length < 32) {
    throw new Error("Region ship receipt signature is invalid");
  }
  const expectedSignature = receiptHmac(unsignedReceipt, config.secretsEncryptionKey);
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSignature, "hex"))) {
    throw new Error("Region ship receipt signature is invalid");
  }
}

function publicShip(receipt: RegionShipReceipt): RegionShipRecord {
  const { receipt_hmac_sha256: _signature, ...record } = receipt;
  return record;
}

function parseReceipt(serialized: string): RegionShipReceipt {
  const candidate: unknown = JSON.parse(serialized);
  if (!isPlainRecord(candidate) || !hasExactKeys(candidate, RECEIPT_KEYS)) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  if (candidate["schema"] !== REGION_SHIP_SCHEMA
    || candidate["transport"] !== REGION_SHIP_TRANSPORT
    || candidate["target_apply"] !== REGION_SHIP_TARGET_APPLY) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  if (typeof candidate["project_ref"] !== "string"
    || typeof candidate["backup_id"] !== "string"
    || !belongsToProject(candidate["backup_id"], candidate["project_ref"])) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  if (typeof candidate["database"] !== "string" || !DATABASE_PATTERN.test(candidate["database"])) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  if (!isKnownRegion(String(candidate["source_region"])) || !isKnownRegion(String(candidate["target_region"]))) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  if (candidate["source_region"] === candidate["target_region"]) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  if (!isCanonicalTimestamp(candidate["shipped_at"])) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  if (!Number.isSafeInteger(candidate["bytes"]) || Number(candidate["bytes"]) <= 0) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  if (typeof candidate["sha256"] !== "string" || !SHA256_PATTERN.test(candidate["sha256"])) {
    throw new Error("Region ship receipt has an invalid shape");
  }
  const receipt = candidate as unknown as RegionShipReceipt;
  assertReceiptSignature(receipt);
  return receipt;
}

async function readReceipt(directory: FileHandle, backupId: string): Promise<RegionShipReceipt | null> {
  const path = childFilePath(directory, receiptName(backupId));
  const metadata = await optionalMetadata(path);
  if (!metadata) return null;
  assertPrivateFile(metadata);
  if (metadata.size > MAX_RECEIPT_BYTES) throw new Error("Region ship receipt size is invalid");
  const file = await open(path, FILE_READ_FLAGS);
  try {
    const text = await file.readFile({ encoding: "utf8" });
    if (!sameFileVersion(metadata, await file.stat())) throw new Error("Region ship receipt changed");
    return parseReceipt(text);
  } finally {
    await file.close();
  }
}

function receiptFor(
  identity: LogicalBackupIdentity,
  sourceRegion: string,
  targetRegion: string,
  shippedAt: string,
): RegionShipReceipt {
  const unsigned: UnsignedRegionShipReceipt = {
    schema: REGION_SHIP_SCHEMA,
    project_ref: identity.project_ref,
    backup_id: identity.backup_id,
    database: identity.database,
    source_region: sourceRegion,
    target_region: targetRegion,
    bytes: identity.bytes,
    sha256: identity.sha256,
    shipped_at: shippedAt,
    transport: REGION_SHIP_TRANSPORT,
    target_apply: REGION_SHIP_TARGET_APPLY,
  };
  return { ...unsigned, receipt_hmac_sha256: receiptHmac(unsigned, config.secretsEncryptionKey) };
}

function sameArchive(receipt: RegionShipReceipt, evidence: { bytes: number; sha256: string }, identity?: LogicalBackupIdentity): boolean {
  if (receipt.bytes !== evidence.bytes || receipt.sha256 !== evidence.sha256) return false;
  if (!identity) return true;
  return receipt.bytes === identity.bytes
    && receipt.sha256 === identity.sha256
    && receipt.database === identity.database
    && receipt.backup_id === identity.backup_id
    && receipt.project_ref === identity.project_ref;
}

function assertReceiptContext(
  receipt: RegionShipReceipt,
  projectRef: string,
  backupId: string,
  sourceRegion: string,
  targetRegion: string,
): void {
  if (receipt.project_ref !== projectRef
    || receipt.backup_id !== backupId
    || receipt.source_region !== sourceRegion
    || receipt.target_region !== targetRegion) {
    throw conflict("Region ship receipt does not match the requested project");
  }
}

async function writeReceipt(
  directory: FileHandle,
  backupId: string,
  receipt: RegionShipReceipt,
): Promise<void> {
  const path = childFilePath(directory, receiptName(backupId));
  let file: FileHandle | null = null;
  try {
    file = await open(path, FILE_CREATE_FLAGS, 0o600);
    await file.writeFile(`${JSON.stringify(receipt)}\n`);
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file?.close();
  }
  await directory.sync();
}

async function writePartialArchive(
  directory: FileHandle,
  backupId: string,
  identity: LogicalBackupIdentity,
): Promise<void> {
  const path = childFilePath(directory, partialName(backupId));
  const file = await open(path, FILE_CREATE_FLAGS, 0o600);
  let position = 0;
  try {
    await copyVerifiedLogicalBackupArchive(identity.project_ref, identity.backup_id, async (chunk) => {
      const result = await file.write(chunk, 0, chunk.byteLength, position);
      const bytesWritten = typeof result === "number" ? result : result.bytesWritten;
      if (bytesWritten !== chunk.byteLength) throw new Error("Region ship archive write was short");
      position += bytesWritten;
    });
    await file.chmod(0o600);
    await file.sync();
  } catch (error: unknown) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  const evidence = await hashPrivateFile(directory, partialName(backupId));
  if (evidence.bytes !== identity.bytes || evidence.sha256 !== identity.sha256 || position !== identity.bytes) {
    await rm(path, { force: true });
    throw new Error("Region ship archive does not match the verified logical backup");
  }
}

async function publishPartial(directory: FileHandle, backupId: string): Promise<void> {
  await link(
    childFilePath(directory, partialName(backupId)),
    childFilePath(directory, archiveName(backupId)),
  );
  await rm(childFilePath(directory, partialName(backupId)), { force: true });
  await directory.sync();
}

type StoredShip = RegionShipRecord | "missing" | "archive-only";

async function storedShip(
  directory: FileHandle,
  projectRef: string,
  backupId: string,
  sourceRegion: string,
  targetRegion: string,
  identity?: LogicalBackupIdentity,
): Promise<StoredShip> {
  const receipt = await readReceipt(directory, backupId);
  const archiveMetadata = await optionalMetadata(childFilePath(directory, archiveName(backupId)));
  if (!receipt && !archiveMetadata) return "missing";
  if (!archiveMetadata) throw conflict("Region ship publication is incomplete");
  const evidence = await hashPrivateFile(directory, archiveName(backupId));
  if (identity && (evidence.bytes !== identity.bytes || evidence.sha256 !== identity.sha256)) {
    throw conflict("Region ship archive does not match the verified logical backup");
  }
  if (!receipt) {
    if (!identity) throw conflict("Region ship publication is incomplete");
    return "archive-only";
  }
  assertReceiptContext(receipt, projectRef, backupId, sourceRegion, targetRegion);
  if (!sameArchive(receipt, evidence, identity)) {
    throw conflict("Region ship archive does not match the verified logical backup");
  }
  return publicShip(receipt);
}

async function withProjectDirectory<T>(
  targetRegion: string,
  projectRef: string,
  create: boolean,
  use: (directory: FileHandle) => Promise<T>,
): Promise<T> {
  const root = await openShipRoot(create);
  try {
    const regionDirectory = create
      ? await openOrCreateMode700Directory(trustedChildPath(root, targetRegion))
      : await openMode700Directory(trustedChildPath(root, targetRegion));
    try {
      if (create) await root.sync();
      const projectDirectory = create
        ? await openOrCreateMode700Directory(trustedChildPath(regionDirectory, projectRef))
        : await openMode700Directory(trustedChildPath(regionDirectory, projectRef));
      try {
        if (create) await regionDirectory.sync();
        return await use(projectDirectory);
      } finally {
        await projectDirectory.close();
      }
    } finally {
      await regionDirectory.close();
    }
  } finally {
    await root.close();
  }
}

function normalizeShipError(error: unknown): RegionShipError {
  if (error instanceof RegionShipError) return error;
  if (error instanceof LogicalBackupContractError) {
    return new RegionShipError(error.kind, error.message, { cause: error });
  }
  if (isMissingPathError(error)) return notFound("Region ship not found");
  return unavailable("Region ship is unavailable", error);
}

async function requireProject(projectRef: string): Promise<{ region: string }> {
  let project;
  try {
    project = await projectRepository.findByRef(projectRef);
  } catch (error: unknown) {
    throw unavailable("Region ship is unavailable", error);
  }
  if (!project) throw notFound("Project not found");
  return { region: projectRegion(project.region) };
}

export async function readRegionShip(
  projectRef: string,
  backupId: string,
  targetRegion: string,
): Promise<RegionShipRecord> {
  try {
    assertShipIdentity(projectRef, backupId, targetRegion);
    const project = await requireProject(projectRef);
    assertRegionPair(project.region, targetRegion);
    const record = await withProjectDirectory(targetRegion, projectRef, false, (directory) => (
      storedShip(directory, projectRef, backupId, project.region, targetRegion)
    ));
    if (record === "missing" || record === "archive-only") throw notFound("Region ship not found");
    return record;
  } catch (error: unknown) {
    throw normalizeShipError(error);
  }
}

export async function shipVerifiedLogicalBackupToRegion(
  projectRef: string,
  backupId: string,
  targetRegion: string,
): Promise<RegionShipRecord> {
  try {
    assertShipIdentity(projectRef, backupId, targetRegion);
    const project = await requireProject(projectRef);
    assertRegionPair(project.region, targetRegion);
    const identity = await readLogicalBackup(projectRef, backupId);
    if (identity.project_ref !== projectRef || identity.backup_id !== backupId) {
      throw conflict("Logical backup does not match the requested project");
    }
    return await withProjectDirectory(targetRegion, projectRef, true, async (directory) => {
      await rm(childFilePath(directory, partialName(backupId)), { force: true });
      const existing = await storedShip(
        directory, projectRef, backupId, project.region, targetRegion, identity,
      );
      if (existing !== "missing" && existing !== "archive-only") return existing;
      const shippedAt = new Date().toISOString();
      if (existing === "missing") {
        await writePartialArchive(directory, backupId, identity);
        try {
          await publishPartial(directory, backupId);
        } catch (error: unknown) {
          await rm(childFilePath(directory, partialName(backupId)), { force: true });
          if (!isExistingPathError(error)) throw error;
        }
      }
      const published = await storedShip(
        directory, projectRef, backupId, project.region, targetRegion, identity,
      );
      if (published !== "missing" && published !== "archive-only") return published;
      try {
        await writeReceipt(directory, backupId, receiptFor(identity, project.region, targetRegion, shippedAt));
      } catch (error: unknown) {
        if (!isExistingPathError(error)) throw error;
      }
      const record = await storedShip(
        directory, projectRef, backupId, project.region, targetRegion, identity,
      );
      if (record === "missing" || record === "archive-only") {
        throw new Error("Region ship receipt was not published");
      }
      return record;
    });
  } catch (error: unknown) {
    throw normalizeShipError(error);
  }
}
