import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { config } from "../config";
import { projectRepository } from "../repositories/project.repository";
import {
  ProjectMigrationLockError,
  withProjectMigrationLocks,
} from "./migration-lock";
import type {
  LogicalBackupIdentity,
  LogicalBackupRestoreRequest,
} from "../types/backup";
import { logger } from "../utils/logger";
import { stableStringify } from "../utils/stable-json";

const LOGICAL_BACKUP_SCHEMA = "supacloud.logical-full-backup.v1" as const;
const LOGICAL_BACKUP_KIND = "logical-full" as const;
const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_ID_PATTERN = /^logical-full_[A-Za-z0-9_-]{1,64}_[a-f0-9]{32}$/;
const BACKUP_ID_SUFFIX_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATABASE_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/;
const RECEIPT_FILE_PATTERN = /^(logical-full_[A-Za-z0-9_-]{1,64}_[a-f0-9]{32})\.json$/;
const RECEIPT_KEYS = [
  "schema",
  "backup_id",
  "project_ref",
  "database",
  "kind",
  "created_at",
  "completed_at",
  "bytes",
  "sha256",
  "receipt_hmac_sha256",
] as const;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const ARCHIVE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const ARCHIVE_CREATE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW;
const MAX_RECEIPT_BYTES = 8 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
type LogicalBackupReceipt = LogicalBackupIdentity & {
  schema: typeof LOGICAL_BACKUP_SCHEMA;
  receipt_hmac_sha256: string;
};

type UnsignedLogicalBackupReceipt = Omit<LogicalBackupReceipt, "receipt_hmac_sha256">;

type LogicalBackupErrorKind = "invalid_request" | "not_found" | "conflict" | "unavailable";

interface ArchiveEvidence {
  bytes: number;
  sha256: string;
}

interface ReceiptInput {
  projectRef: string;
  database: string;
  backupId: string;
  createdAt: string;
  completedAt: string;
  evidence: ArchiveEvidence;
}

interface OpenArchive {
  file: FileHandle;
  path: string;
  metadata: Stats;
}

export class LogicalBackupContractError extends Error {
  constructor(
    readonly kind: LogicalBackupErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LogicalBackupContractError";
  }
}

function invalidRequest(message: string): LogicalBackupContractError {
  return new LogicalBackupContractError("invalid_request", message);
}

function notFound(message: string): LogicalBackupContractError {
  return new LogicalBackupContractError("not_found", message);
}

function conflict(message: string): LogicalBackupContractError {
  return new LogicalBackupContractError("conflict", message);
}

function unavailable(operation: string, cause: unknown): LogicalBackupContractError {
  logger.error(`[LogicalBackup] ${operation} unavailable`, {
    cause: cause instanceof Error ? cause.name : "UnknownError",
  });
  return new LogicalBackupContractError(
    "unavailable",
    `Logical backup ${operation} is unavailable`,
    { cause },
  );
}

function assertProjectRef(projectRef: string): void {
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw invalidRequest("Invalid project ref");
  }
}

function backupIdForProject(projectRef: string): string {
  return `logical-full_${projectRef}_${randomUUID().replaceAll("-", "")}`;
}

function belongsToProject(backupId: string, projectRef: string): boolean {
  const projectPrefix = `logical-full_${projectRef}_`;
  return BACKUP_ID_PATTERN.test(backupId)
    && backupId.startsWith(projectPrefix)
    && BACKUP_ID_SUFFIX_PATTERN.test(backupId.slice(projectPrefix.length));
}

function archiveFilename(backupId: string): string {
  return `.${backupId}.dump`;
}

function receiptFilename(backupId: string): string {
  return `${backupId}.json`;
}

function pendingReceiptFilename(backupId: string): string {
  return `.${backupId}.receipt.pending`;
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

function parseLogicalBackupReceipt(serializedReceipt: string): LogicalBackupReceipt {
  const candidate: unknown = JSON.parse(serializedReceipt);
  if (!isPlainRecord(candidate) || !hasExactKeys(candidate, RECEIPT_KEYS)) {
    throw new Error("Logical backup receipt has an invalid shape");
  }
  assertReceiptIdentity(candidate);
  const receipt = candidate as unknown as LogicalBackupReceipt;
  assertReceiptSignature(receipt);
  return receipt;
}

function invalidReceiptIdentity(): never {
  throw new Error("Logical backup receipt has invalid identity fields");
}

function assertReceiptProject(candidate: Record<string, unknown>): void {
  if (candidate.schema !== LOGICAL_BACKUP_SCHEMA || candidate.kind !== LOGICAL_BACKUP_KIND) {
    invalidReceiptIdentity();
  }
  if (typeof candidate.backup_id !== "string" || !BACKUP_ID_PATTERN.test(candidate.backup_id)) {
    invalidReceiptIdentity();
  }
  if (typeof candidate.project_ref !== "string"
    || !belongsToProject(candidate.backup_id, candidate.project_ref)) {
    invalidReceiptIdentity();
  }
}

function assertReceiptDatabase(candidate: Record<string, unknown>): void {
  if (typeof candidate.database !== "string" || !DATABASE_PATTERN.test(candidate.database)) {
    invalidReceiptIdentity();
  }
}

function assertReceiptTimestamps(candidate: Record<string, unknown>): void {
  if (!isCanonicalTimestamp(candidate.created_at) || !isCanonicalTimestamp(candidate.completed_at)) {
    invalidReceiptIdentity();
  }
  if (new Date(candidate.completed_at).valueOf() < new Date(candidate.created_at).valueOf()) {
    invalidReceiptIdentity();
  }
}

function assertReceiptEvidence(candidate: Record<string, unknown>): void {
  if (!Number.isSafeInteger(candidate.bytes) || Number(candidate.bytes) <= 0) {
    invalidReceiptIdentity();
  }
  if (typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256)) {
    invalidReceiptIdentity();
  }
  if (typeof candidate.receipt_hmac_sha256 !== "string"
    || !SHA256_PATTERN.test(candidate.receipt_hmac_sha256)) {
    invalidReceiptIdentity();
  }
}

function assertReceiptIdentity(candidate: Record<string, unknown>): void {
  assertReceiptProject(candidate);
  assertReceiptDatabase(candidate);
  assertReceiptTimestamps(candidate);
  assertReceiptEvidence(candidate);
}

function receiptHmac(receipt: UnsignedLogicalBackupReceipt, signingKey: string): string {
  if (signingKey.length < 32) {
    throw new Error("Logical backup receipt signing key is unavailable");
  }
  return createHmac("sha256", signingKey)
    .update(stableStringify(receipt))
    .digest("hex");
}

function receiptVerificationKeys(): string[] {
  const keys = [config.secretsEncryptionKey];
  const legacyKey = config.legacySecretsEncryptionKey;
  if (legacyKey && legacyKey.length >= 32 && legacyKey !== config.secretsEncryptionKey) {
    keys.push(legacyKey);
  }
  return keys;
}

function assertReceiptSignature(receipt: LogicalBackupReceipt): void {
  const { receipt_hmac_sha256: signature, ...unsignedReceipt } = receipt;
  const receivedSignature = Buffer.from(signature, "hex");
  const signatureMatches = receiptVerificationKeys().some((verificationKey) => {
    const expectedSignature = receiptHmac(unsignedReceipt, verificationKey);
    return timingSafeEqual(receivedSignature, Buffer.from(expectedSignature, "hex"));
  });
  if (!signatureMatches) {
    throw new Error("Logical backup receipt signature is invalid");
  }
}

function identityFromReceipt(receipt: LogicalBackupReceipt): LogicalBackupIdentity {
  const { schema: _schema, receipt_hmac_sha256: _receiptHmac, ...identity } = receipt;
  return identity;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertTrustedDirectory(metadata: Stats): void {
  const effectiveUid = process.geteuid?.();
  const trustedOwner = effectiveUid !== undefined
    && (metadata.uid === 0 || metadata.uid === effectiveUid);
  if (!metadata.isDirectory() || !trustedOwner || (metadata.mode & 0o022) !== 0) {
    throw new Error("Logical backup directory is not trusted");
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

function canonicalDirectoryChain(directoryPath: string): string[] {
  if (resolve(directoryPath) !== directoryPath) {
    throw new Error("Logical backup directory path is not canonical");
  }
  const filesystemRoot = parsePath(directoryPath).root;
  const pathSegments = relative(filesystemRoot, directoryPath).split(sep).filter(Boolean);
  const chain = [filesystemRoot];
  for (const pathSegment of pathSegments) chain.push(join(chain.at(-1)!, pathSegment));
  return chain;
}

async function openTrustedDirectory(directoryPath: string): Promise<FileHandle> {
  const pathMetadata = await lstat(directoryPath);
  assertTrustedDirectory(pathMetadata);
  const directory = await open(directoryPath, DIRECTORY_OPEN_FLAGS);
  try {
    const descriptorMetadata = await directory.stat();
    assertTrustedDirectory(descriptorMetadata);
    if (sameInode(pathMetadata, descriptorMetadata)) return directory;
    throw new Error("Logical backup directory identity changed");
  } catch (error: unknown) {
    await directory.close();
    throw error;
  }
}

function trustedChildPath(
  parent: FileHandle,
  parentPath: string,
  childName: string,
): string {
  if (childName !== basename(childName)) throw new Error("Invalid logical backup directory name");
  return process.platform === "linux"
    ? `/proc/self/fd/${parent.fd}/${childName}`
    : join(parentPath, childName);
}

function isExistingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function openOrCreateTrustedDirectory(directoryPath: string): Promise<FileHandle> {
  try {
    return await openTrustedDirectory(directoryPath);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
  }
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isExistingPathError(error)) throw error;
  }
  return openTrustedDirectory(directoryPath);
}

async function openTrustedDirectoryChain(directoryPath: string): Promise<FileHandle> {
  const [filesystemRoot, ...pathEntries] = canonicalDirectoryChain(directoryPath);
  let trustedDirectory = await openTrustedDirectory(filesystemRoot!);
  let trustedPath = filesystemRoot!;
  try {
    for (const pathEntry of pathEntries) {
      const childPath = trustedChildPath(trustedDirectory, trustedPath, basename(pathEntry));
      const nextDirectory = await openOrCreateTrustedDirectory(childPath);
      await trustedDirectory.close();
      trustedDirectory = nextDirectory;
      trustedPath = pathEntry;
    }
    return trustedDirectory;
  } catch (error: unknown) {
    await trustedDirectory.close();
    throw error;
  }
}

async function logicalBackupRoot(): Promise<FileHandle> {
  const rootPath = logicalBackupRootPath();
  const root = await openTrustedDirectoryChain(rootPath);
  try {
    const metadata = await root.stat();
    if ((metadata.mode & 0o777) === 0o700) return root;
    throw new Error("Logical backup root must use mode 0700");
  } catch (error: unknown) {
    await root.close();
    throw error;
  }
}

function logicalBackupRootPath(): string {
  return resolve(
    process.env.SUPACLOUD_LOGICAL_BACKUP_DIR || "/var/lib/supacloud/backups/logical-full",
  );
}

function directoryEntryPath(directory: FileHandle, filename: string): string {
  if (filename !== basename(filename)) throw new Error("Invalid logical backup filename");
  return process.platform === "linux"
    ? `/proc/self/fd/${directory.fd}/${filename}`
    : join(logicalBackupRootPath(), filename);
}

function openedDirectoryPath(directory: FileHandle): string {
  return process.platform === "linux"
    ? `/proc/self/fd/${directory.fd}`
    : logicalBackupRootPath();
}

function assertPrivateRegularFile(metadata: Stats, expectedBytes?: number): void {
  const effectiveUid = process.geteuid?.();
  const trustedOwner = effectiveUid !== undefined
    && (metadata.uid === 0 || metadata.uid === effectiveUid);
  if (!metadata.isFile()
    || !trustedOwner
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || (expectedBytes !== undefined && metadata.size !== expectedBytes)) {
    throw new Error("Logical backup file identity is invalid");
  }
}

async function openPrivateFile(root: FileHandle, filename: string): Promise<OpenArchive> {
  const path = directoryEntryPath(root, filename);
  const pathMetadata = await lstat(path);
  assertPrivateRegularFile(pathMetadata);
  const file = await open(path, ARCHIVE_OPEN_FLAGS);
  try {
    const metadata = await file.stat();
    assertPrivateRegularFile(metadata);
    if (sameFileVersion(pathMetadata, metadata)) return { file, path, metadata };
    throw new Error("Logical backup file identity changed");
  } catch (error: unknown) {
    await file.close();
    throw error;
  }
}

async function assertOpenFileStable(openedFile: OpenArchive): Promise<void> {
  const descriptorMetadata = await openedFile.file.stat();
  const pathMetadata = await lstat(openedFile.path);
  if (!sameFileVersion(openedFile.metadata, descriptorMetadata)
    || !sameInode(openedFile.metadata, pathMetadata)) {
    throw new Error("Logical backup file changed during verification");
  }
}

async function sha256OpenFile(file: FileHandle, bytes: number): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, bytes));
  let position = 0;
  while (position < bytes) {
    const requestedBytes = Math.min(buffer.length, bytes - position);
    const { bytesRead } = await file.read(buffer, 0, requestedBytes, position);
    if (bytesRead === 0) throw new Error("Logical backup archive ended during hashing");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

async function databaseCommandExitCode(databaseProcess: ReturnType<typeof Bun.spawn>): Promise<number> {
  return databaseProcess.exited;
}

async function validateArchiveCatalog(archiveFile: FileHandle): Promise<void> {
  const validationProcess = Bun.spawn({
    cmd: ["pg_restore", "--list"],
    stdin: archiveFile.fd,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (await databaseCommandExitCode(validationProcess) !== 0) {
    throw new Error("Logical backup archive catalog is invalid");
  }
}

async function archiveEvidence(root: FileHandle, backupId: string): Promise<ArchiveEvidence> {
  const openedArchive = await openPrivateFile(root, archiveFilename(backupId));
  try {
    assertPrivateRegularFile(openedArchive.metadata);
    if (openedArchive.metadata.size <= 0) throw new Error("Logical backup archive is empty");
    const sha256 = await sha256OpenFile(openedArchive.file, openedArchive.metadata.size);
    await validateArchiveCatalog(openedArchive.file);
    await assertOpenFileStable(openedArchive);
    return { bytes: openedArchive.metadata.size, sha256 };
  } finally {
    await openedArchive.file.close();
  }
}

async function readPrivateTextFile(root: FileHandle, filename: string): Promise<string> {
  const openedReceipt = await openPrivateFile(root, filename);
  try {
    if (openedReceipt.metadata.size <= 0 || openedReceipt.metadata.size > MAX_RECEIPT_BYTES) {
      throw new Error("Logical backup receipt size is invalid");
    }
    const serializedReceipt = await readFile(openedReceipt.file, "utf8");
    await assertOpenFileStable(openedReceipt);
    return serializedReceipt;
  } finally {
    await openedReceipt.file.close();
  }
}

async function verifiedBackup(
  root: FileHandle,
  backupId: string,
  projectRef: string,
  database: string,
): Promise<LogicalBackupIdentity> {
  const serializedReceipt = await readPrivateTextFile(root, receiptFilename(backupId));
  const receipt = parseLogicalBackupReceipt(serializedReceipt);
  if (receipt.backup_id !== backupId
    || receipt.project_ref !== projectRef
    || receipt.database !== database) {
    throw new Error("Logical backup receipt does not match the requested project");
  }
  const evidence = await archiveEvidence(root, backupId);
  if (receipt.bytes !== evidence.bytes || receipt.sha256 !== evidence.sha256) {
    throw new Error("Logical backup archive does not match its receipt");
  }
  return identityFromReceipt(receipt);
}

async function requiredProject(projectRef: string) {
  assertProjectRef(projectRef);
  let project;
  try {
    project = await projectRepository.findByRef(projectRef);
  } catch (error: unknown) {
    throw unavailable("project lookup", error);
  }
  if (!project) throw notFound("Project not found");
  return project;
}

async function runLogicalDump(database: string, archiveFile: FileHandle): Promise<void> {
  const dumpProcess = Bun.spawn({
    cmd: [
      "pg_dump",
      "-h", config.pgHost,
      "-p", String(config.pgPort),
      "-U", config.pgUser,
      "-d", database,
      "--format=custom",
      "--compress=6",
    ],
    env: { ...process.env, PGPASSWORD: config.pgPassword },
    stdout: archiveFile.fd,
    stderr: "ignore",
  });
  if (await databaseCommandExitCode(dumpProcess) !== 0) {
    throw new Error("pg_dump failed");
  }
}

async function reserveArchive(root: FileHandle, backupId: string): Promise<FileHandle> {
  const archivePath = directoryEntryPath(root, archiveFilename(backupId));
  const archiveFile = await open(archivePath, ARCHIVE_CREATE_FLAGS, 0o600);
  const metadata = await archiveFile.stat();
  assertPrivateRegularFile(metadata, 0);
  return archiveFile;
}

function receiptFor(input: ReceiptInput): LogicalBackupReceipt {
  const unsignedReceipt: UnsignedLogicalBackupReceipt = {
    schema: LOGICAL_BACKUP_SCHEMA,
    backup_id: input.backupId,
    project_ref: input.projectRef,
    database: input.database,
    kind: LOGICAL_BACKUP_KIND,
    created_at: input.createdAt,
    completed_at: input.completedAt,
    bytes: input.evidence.bytes,
    sha256: input.evidence.sha256,
  };
  return {
    ...unsignedReceipt,
    receipt_hmac_sha256: receiptHmac(unsignedReceipt, config.secretsEncryptionKey),
  };
}

async function writePendingReceipt(
  root: FileHandle,
  backupId: string,
  receipt: LogicalBackupReceipt,
): Promise<void> {
  const pendingPath = directoryEntryPath(root, pendingReceiptFilename(backupId));
  let receiptFile: FileHandle | null = null;
  try {
    receiptFile = await open(pendingPath, ARCHIVE_CREATE_FLAGS, 0o600);
    await receiptFile.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
    await receiptFile.chmod(0o600);
    await receiptFile.sync();
  } catch (error: unknown) {
    await rm(pendingPath, { force: true });
    throw error;
  } finally {
    await receiptFile?.close();
  }
}

async function publishReceipt(root: FileHandle, backupId: string): Promise<void> {
  const pendingPath = directoryEntryPath(root, pendingReceiptFilename(backupId));
  const publishedPath = directoryEntryPath(root, receiptFilename(backupId));
  let linked = false;
  try {
    await link(pendingPath, publishedPath);
    linked = true;
    await rm(pendingPath);
    await root.sync();
  } catch (error: unknown) {
    if (linked) await rm(publishedPath, { force: true });
    throw error;
  }
}

async function removeOwnedBackupFiles(root: FileHandle, backupId: string): Promise<void> {
  const ownedPaths = [
    archiveFilename(backupId),
    pendingReceiptFilename(backupId),
    receiptFilename(backupId),
  ];
  await Promise.all(ownedPaths.map((filename) => (
    rm(directoryEntryPath(root, filename), { force: true })
  )));
  await root.sync();
}

async function writeArchiveContents(
  archiveFile: FileHandle,
  database: string,
): Promise<void> {
  try {
    await runLogicalDump(database, archiveFile);
    await archiveFile.chmod(0o600);
    await archiveFile.sync();
  } finally {
    await archiveFile.close();
  }
}

async function createVerifiedArchive(
  root: FileHandle,
  backupId: string,
  database: string,
): Promise<ArchiveEvidence> {
  const archiveFile = await reserveArchive(root, backupId);
  try {
    await writeArchiveContents(archiveFile, database);
    return await archiveEvidence(root, backupId);
  } catch (error: unknown) {
    await removeOwnedBackupFiles(root, backupId);
    throw error;
  }
}

async function publishBackupReceipt(
  root: FileHandle,
  backupId: string,
  receipt: LogicalBackupReceipt,
): Promise<void> {
  await writePendingReceipt(root, backupId, receipt);
  await publishReceipt(root, backupId);
}

async function createStoredBackup(
  root: FileHandle,
  projectRef: string,
  database: string,
): Promise<LogicalBackupIdentity> {
  const backupId = backupIdForProject(projectRef);
  const createdAt = new Date().toISOString();
  const evidence = await createVerifiedArchive(root, backupId, database);
  const receipt = receiptFor({
    projectRef,
    database,
    backupId,
    createdAt,
    completedAt: new Date().toISOString(),
    evidence,
  });
  try {
    await publishBackupReceipt(root, backupId, receipt);
    return await verifiedBackup(root, backupId, projectRef, database);
  } catch (error: unknown) {
    await removeOwnedBackupFiles(root, backupId);
    throw error;
  }
}

function receiptBackupId(filename: string, projectRef: string): string | null {
  const match = filename.match(RECEIPT_FILE_PATTERN);
  if (!match || !belongsToProject(match[1]!, projectRef)) return null;
  return match[1]!;
}

async function projectBackupIds(root: FileHandle, projectRef: string): Promise<string[]> {
  const entries = await readdir(openedDirectoryPath(root), { withFileTypes: true });
  const backupIds: string[] = [];
  for (const entry of entries) {
    const backupId = receiptBackupId(entry.name, projectRef);
    if (!backupId) continue;
    if (!entry.isFile()) throw new Error("Logical backup receipt is not a regular file");
    backupIds.push(backupId);
  }
  return backupIds.sort();
}

export async function listLogicalBackups(projectRef: string): Promise<LogicalBackupIdentity[]> {
  const project = await requiredProject(projectRef);
  let root: FileHandle | null = null;
  try {
    root = await logicalBackupRoot();
    const backupIds = await projectBackupIds(root, projectRef);
    const backups = await Promise.all(backupIds.map((backupId) => (
      verifiedBackup(root!, backupId, projectRef, project.db_name)
    )));
    return backups.sort((left, right) => (
      right.completed_at.localeCompare(left.completed_at)
      || right.backup_id.localeCompare(left.backup_id)
    ));
  } catch (error: unknown) {
    if (error instanceof LogicalBackupContractError) throw error;
    throw unavailable("inventory", error);
  } finally {
    await root?.close();
  }
}

export async function createLogicalBackup(projectRef: string): Promise<LogicalBackupIdentity> {
  const project = await requiredProject(projectRef);
  let root: FileHandle | null = null;
  try {
    root = await logicalBackupRoot();
    return await createStoredBackup(root, projectRef, project.db_name);
  } catch (error: unknown) {
    if (error instanceof LogicalBackupContractError) throw error;
    throw unavailable("creation", error);
  } finally {
    await root?.close();
  }
}

function assertRestoreRequest(request: LogicalBackupRestoreRequest): void {
  assertProjectRef(request.project_ref);
  if (!BACKUP_ID_PATTERN.test(request.backup_id)
    || !SHA256_PATTERN.test(request.expected_sha256)) {
    throw invalidRequest("Invalid logical backup restore identity");
  }
  const expectedConfirmation = [
    "RESTORE_PROJECT",
    request.project_ref,
    request.backup_id,
    request.expected_sha256,
  ].join(":");
  if (request.confirmation !== expectedConfirmation) {
    throw invalidRequest("Exact logical backup restore confirmation is required");
  }
}

async function assertProjectPaused(projectRef: string): Promise<Awaited<ReturnType<typeof requiredProject>>> {
  const project = await requiredProject(projectRef);
  if (project.status !== "paused") {
    throw conflict("Project must be paused before logical restore");
  }
  return project;
}

async function openVerifiedRestoreArchive(
  root: FileHandle,
  backupId: string,
  expectedSha256: string,
): Promise<OpenArchive> {
  const openedArchive = await openPrivateFile(root, archiveFilename(backupId));
  try {
    const actualSha256 = await sha256OpenFile(openedArchive.file, openedArchive.metadata.size);
    await assertOpenFileStable(openedArchive);
    if (actualSha256 === expectedSha256) return openedArchive;
    throw new Error("Logical backup archive digest changed before restore");
  } catch (error: unknown) {
    await openedArchive.file.close();
    throw error;
  }
}

async function runLogicalRestore(database: string, openedArchive: OpenArchive): Promise<void> {
  const restoreProcess = Bun.spawn({
    cmd: [
      "pg_restore",
      "-h", config.pgHost,
      "-p", String(config.pgPort),
      "-U", config.pgUser,
      "-d", database,
      "--clean",
      "--if-exists",
      "--exit-on-error",
      "--single-transaction",
    ],
    env: { ...process.env, PGPASSWORD: config.pgPassword },
    stdin: openedArchive.file.fd,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (await databaseCommandExitCode(restoreProcess) !== 0) {
    throw new Error("pg_restore failed");
  }
  await assertOpenFileStable(openedArchive);
}

async function restoreVerifiedBackup(
  root: FileHandle,
  request: LogicalBackupRestoreRequest,
  database: string,
): Promise<LogicalBackupIdentity> {
  const before = await verifiedBackup(root, request.backup_id, request.project_ref, database);
  if (before.sha256 !== request.expected_sha256) {
    throw conflict("Logical backup digest does not match expected_sha256");
  }
  await assertProjectPaused(request.project_ref);
  const openedArchive = await openVerifiedRestoreArchive(root, request.backup_id, before.sha256);
  try {
    await runLogicalRestore(database, openedArchive);
  } finally {
    await openedArchive.file.close();
  }
  await assertProjectPaused(request.project_ref);
  return verifiedBackup(root, request.backup_id, request.project_ref, database);
}

async function restoreLogicalBackupLocked(
  request: LogicalBackupRestoreRequest,
): Promise<LogicalBackupIdentity> {
  let root: FileHandle | null = null;
  try {
    const project = await assertProjectPaused(request.project_ref);
    root = await logicalBackupRoot();
    return await restoreVerifiedBackup(root, request, project.db_name);
  } finally {
    await root?.close();
  }
}

export async function restoreLogicalBackup(
  request: LogicalBackupRestoreRequest,
): Promise<LogicalBackupIdentity> {
  assertRestoreRequest(request);
  if (!belongsToProject(request.backup_id, request.project_ref)) {
    throw notFound("Logical backup not found");
  }
  try {
    return await withProjectMigrationLocks(
      { projectRefs: [request.project_ref] },
      () => restoreLogicalBackupLocked(request),
    );
  } catch (error: unknown) {
    if (error instanceof LogicalBackupContractError) throw error;
    if (error instanceof ProjectMigrationLockError) {
      throw conflict("Another database operation is already in progress for this project");
    }
    if (isMissingPathError(error)) throw notFound("Logical backup not found");
    throw unavailable("restore", error);
  }
}
