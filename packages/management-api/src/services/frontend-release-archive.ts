import { constants as fsConstants } from "node:fs";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import {
  FRONTEND_RELEASE_MAX_FILES,
  FRONTEND_RELEASE_MAX_UNCOMPRESSED_BYTES,
  frontendReleaseError,
} from "./frontend-release-contract";

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP_ALLOWED_FLAGS = 0x080e;
const ZIP_MAX_END_RECORD_BYTES = 65_557;
const ARCHIVE_CHUNK_BYTES = 64 * 1024;

export interface VerifiedZipFileEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
  dataEnd: number;
  recordEnd: number;
  crc32: number;
  flags: number;
  compression: number;
}

interface ArchiveIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface VerifiedZipArchive {
  readonly size: number;
  readonly identity: ArchiveIdentity;
  readonly entries: readonly VerifiedZipFileEntry[];
}

interface ZipCentralDirectory {
  offset: number;
  size: number;
  entries: number;
}

function invalidZip(message: string): never {
  throw frontendReleaseError("FRONTEND_RELEASE_ARCHIVE_INVALID", 400, message);
}

function archiveIdentity(metadata: Awaited<ReturnType<FileHandle["stat"]>>): ArchiveIdentity {
  if (!metadata.isFile()) invalidZip("Frontend release archive must be a regular file");
  return {
    dev: Number(metadata.dev),
    ino: Number(metadata.ino),
    size: Number(metadata.size),
    mtimeMs: Number(metadata.mtimeMs),
    ctimeMs: Number(metadata.ctimeMs),
  };
}

function sameArchive(left: ArchiveIdentity, right: ArchiveIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function assertArchiveIdentity(handle: FileHandle, expected: ArchiveIdentity): Promise<void> {
  if (!sameArchive(expected, archiveIdentity(await handle.stat()))) {
    invalidZip("Frontend release archive changed while it was verified");
  }
}

async function readExactly(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    return invalidZip("Zip archive range is invalid");
  }
  const bytes = Buffer.allocUnsafe(length);
  let readOffset = 0;
  while (readOffset < length) {
    const read = await handle.read(bytes, readOffset, length - readOffset, offset + readOffset);
    if (read.bytesRead === 0) return invalidZip("Zip archive ended unexpectedly");
    readOffset += read.bytesRead;
  }
  return bytes;
}

function endRecordOffset(tail: Buffer, archiveSize: number): number {
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return archiveSize - tail.byteLength + offset;
    }
  }
  return invalidZip("Frontend release archive is not a supported zip file");
}

async function centralDirectory(handle: FileHandle, archiveSize: number): Promise<ZipCentralDirectory> {
  const tailSize = Math.min(archiveSize, ZIP_MAX_END_RECORD_BYTES);
  const tail = await readExactly(handle, archiveSize - tailSize, tailSize);
  const endOffset = endRecordOffset(tail, archiveSize);
  const recordOffset = endOffset - (archiveSize - tailSize);
  const entries = tail.readUInt16LE(recordOffset + 10);
  const size = tail.readUInt32LE(recordOffset + 12);
  const offset = tail.readUInt32LE(recordOffset + 16);
  const commentLength = tail.readUInt16LE(recordOffset + 20);
  const zip64 = entries === 0xffff || size === 0xffffffff || offset === 0xffffffff;
  if (tail.readUInt16LE(recordOffset + 4) !== 0 || tail.readUInt16LE(recordOffset + 6) !== 0
    || tail.readUInt16LE(recordOffset + 8) !== entries || zip64
    || endOffset + 22 + commentLength !== archiveSize || offset + size !== endOffset
    || entries < 1 || entries > FRONTEND_RELEASE_MAX_FILES) {
    invalidZip("Zip archive structure is unsupported or invalid");
  }
  return { offset, size, entries };
}

function zipEntryPath(nameBytes: Uint8Array, flags: number): string {
  if (!nameBytes.every((byte) => byte < 0x80) && (flags & 0x0800) === 0) {
    invalidZip("Zip entry names must use UTF-8");
  }
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    return invalidZip("Zip entry names must be valid UTF-8");
  }
  if (!name || name.length > 1024 || name.startsWith("/") || name.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(name)) {
    return invalidZip("Zip archive contains an unsafe path");
  }
  const directory = name.endsWith("/");
  const segments = name.split("/");
  if (directory) segments.pop();
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return invalidZip("Zip archive contains an unsafe path");
  }
  return directory ? `${segments.join("/")}/` : segments.join("/");
}

function assertEntryType(madeBy: number, externalAttributes: number, path: string): void {
  const hostSystem = madeBy >>> 8;
  const unixFileType = hostSystem === 3 ? (externalAttributes >>> 16) & 0o170000 : 0;
  if (unixFileType !== 0 && unixFileType !== 0o100000 && unixFileType !== 0o040000) {
    invalidZip("Zip archive contains a non-regular file");
  }
  const directory = path.endsWith("/");
  const declaredDirectory = unixFileType === 0o040000 || (externalAttributes & 0x10) !== 0;
  if (declaredDirectory !== directory || (unixFileType === 0o100000 && directory)) {
    invalidZip("Zip archive entry type is inconsistent");
  }
}

async function centralEntry(
  handle: FileHandle,
  offset: number,
  limit: number,
): Promise<{
  entry: Omit<VerifiedZipFileEntry, "dataOffset" | "dataEnd" | "recordEnd"> | null;
  nextOffset: number;
  path: string;
}> {
  if (offset + 46 > limit) invalidZip("Zip central directory is invalid");
  const header = await readExactly(handle, offset, 46);
  if (header.readUInt32LE(0) !== ZIP_CENTRAL_HEADER) invalidZip("Zip central directory is invalid");
  const flags = header.readUInt16LE(8);
  const compression = header.readUInt16LE(10);
  const compressedSize = header.readUInt32LE(20);
  const uncompressedSize = header.readUInt32LE(24);
  const nameLength = header.readUInt16LE(28);
  const extraLength = header.readUInt16LE(30);
  const commentLength = header.readUInt16LE(32);
  const localHeaderOffset = header.readUInt32LE(42);
  const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
  if (nextOffset > limit || nameLength === 0 || nameLength > 4096 || header.readUInt16LE(34) !== 0
    || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
    || localHeaderOffset === 0xffffffff || (flags & ~ZIP_ALLOWED_FLAGS) !== 0
    || (flags & 1) !== 0 || ![0, 8].includes(compression)) {
    invalidZip("Zip archive uses unsupported features");
  }
  const path = zipEntryPath(await readExactly(handle, offset + 46, nameLength), flags);
  assertEntryType(header.readUInt16LE(4), header.readUInt32LE(38), path);
  return {
    entry: path.endsWith("/") ? null : {
      path,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      crc32: header.readUInt32LE(16),
      flags,
      compression,
    },
    nextOffset,
    path,
  };
}

async function dataDescriptorEnd(
  handle: FileHandle,
  dataEnd: number,
  centralOffset: number,
  entry: Omit<VerifiedZipFileEntry, "dataOffset" | "dataEnd" | "recordEnd">,
): Promise<number> {
  if ((entry.flags & 0x0008) === 0) return dataEnd;
  if (dataEnd + 12 > centralOffset) invalidZip("Zip data descriptor is invalid");
  const prefix = await readExactly(handle, dataEnd, 4);
  const hasSignature = prefix.readUInt32LE(0) === ZIP_DATA_DESCRIPTOR;
  const descriptorOffset = dataEnd + (hasSignature ? 4 : 0);
  const recordEnd = descriptorOffset + 12;
  if (recordEnd > centralOffset) invalidZip("Zip data descriptor is invalid");
  const descriptor = await readExactly(handle, descriptorOffset, 12);
  if (descriptor.readUInt32LE(0) !== entry.crc32
    || descriptor.readUInt32LE(4) !== entry.compressedSize
    || descriptor.readUInt32LE(8) !== entry.uncompressedSize) {
    invalidZip("Zip data descriptor is invalid");
  }
  return recordEnd;
}

async function localEntryRange(
  handle: FileHandle,
  entry: Omit<VerifiedZipFileEntry, "dataOffset" | "dataEnd" | "recordEnd">,
  centralOffset: number,
): Promise<[number, number, number]> {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > centralOffset) invalidZip("Zip local header is invalid");
  const header = await readExactly(handle, offset, 30);
  if (header.readUInt32LE(0) !== ZIP_LOCAL_HEADER) invalidZip("Zip local header is invalid");
  const flags = header.readUInt16LE(6);
  const compression = header.readUInt16LE(8);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (nameLength === 0 || nameLength > 4096 || dataOffset > centralOffset || dataEnd > centralOffset) {
    invalidZip("Zip local header is invalid");
  }
  const localName = zipEntryPath(await readExactly(handle, offset + 30, nameLength), flags);
  const descriptor = (flags & 0x0008) !== 0;
  const crcMatches = descriptor || header.readUInt32LE(14) === entry.crc32;
  const sizesMatch = descriptor || (header.readUInt32LE(18) === entry.compressedSize
    && header.readUInt32LE(22) === entry.uncompressedSize);
  if (localName !== entry.path || flags !== entry.flags || compression !== entry.compression
    || !crcMatches || !sizesMatch) {
    invalidZip("Zip local and central records do not match");
  }
  return [dataOffset, dataEnd, await dataDescriptorEnd(handle, dataEnd, centralOffset, entry)];
}

function assertPathHierarchy(paths: readonly string[]): void {
  const files = new Set(paths);
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    let ancestor = "";
    for (const segment of segments) {
      ancestor = ancestor ? `${ancestor}/${segment}` : segment;
      if (files.has(ancestor)) invalidZip("Zip archive contains conflicting file and directory paths");
    }
  }
}

function assertNonOverlappingRanges(entries: readonly VerifiedZipFileEntry[]): void {
  const ranges = entries.map((entry) => [entry.localHeaderOffset, entry.recordEnd] as const)
    .sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) invalidZip("Zip archive entries overlap");
  }
}

export async function verifiedZipArchive(
  handle: FileHandle,
  archiveSize: number,
): Promise<VerifiedZipArchive> {
  const identity = archiveIdentity(await handle.stat());
  if (identity.size !== archiveSize || archiveSize < 22) invalidZip("Frontend release archive size is invalid");
  const central = await centralDirectory(handle, archiveSize);
  const centralLimit = central.offset + central.size;
  const paths = new Set<string>();
  const files: VerifiedZipFileEntry[] = [];
  let totalBytes = 0;
  let cursor = central.offset;
  for (let index = 0; index < central.entries; index += 1) {
    const parsed = await centralEntry(handle, cursor, centralLimit);
    if (paths.has(parsed.path)) invalidZip("Zip archive contains duplicate paths");
    paths.add(parsed.path);
    if (parsed.entry) {
      totalBytes += parsed.entry.uncompressedSize;
      if (totalBytes > FRONTEND_RELEASE_MAX_UNCOMPRESSED_BYTES) {
        invalidZip("Zip archive is incomplete or exceeds release limits");
      }
      const [dataOffset, dataEnd, recordEnd] = await localEntryRange(handle, parsed.entry, central.offset);
      files.push({ ...parsed.entry, dataOffset, dataEnd, recordEnd });
    }
    cursor = parsed.nextOffset;
  }
  if (cursor !== centralLimit || files.length < 1 || !files.some((entry) => entry.path === "index.html")) {
    invalidZip("Zip archive is incomplete or exceeds release limits");
  }
  assertPathHierarchy(files.map((entry) => entry.path));
  assertNonOverlappingRanges(files);
  await assertArchiveIdentity(handle, identity);
  return { size: archiveSize, identity, entries: files };
}

async function* compressedChunks(
  handle: FileHandle,
  entry: VerifiedZipFileEntry,
): AsyncGenerator<Buffer> {
  let offset = entry.dataOffset;
  while (offset < entry.dataEnd) {
    const length = Math.min(ARCHIVE_CHUNK_BYTES, entry.dataEnd - offset);
    yield await readExactly(handle, offset, length);
    offset += length;
  }
}

let crcTable: Uint32Array | undefined;

function crc32Table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    crcTable[index] = crc >>> 0;
  }
  return crcTable;
}

function updateCrc32(crc: number, bytes: Uint8Array): number {
  const table = crc32Table();
  let updated = crc;
  for (const byte of bytes) updated = (updated >>> 8) ^ table[(updated ^ byte) & 0xff];
  return updated >>> 0;
}

function isDeflateError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["Z_DATA_ERROR", "Z_BUF_ERROR", "Z_STREAM_ERROR"].includes(
    String((error as Error & { code?: unknown }).code),
  );
}

async function writeAll(output: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await output.write(bytes, offset, bytes.byteLength - offset);
    if (written.bytesWritten === 0) throw new Error("Frontend release extraction write made no progress");
    offset += written.bytesWritten;
  }
}

async function extractedChunks(
  handle: FileHandle,
  entry: VerifiedZipFileEntry,
): Promise<AsyncIterable<Uint8Array>> {
  const chunks = Readable.from(compressedChunks(handle, entry));
  if (entry.compression === 0) return chunks;
  return chunks.pipe(createInflateRaw());
}

async function writeExtractedEntry(
  archiveHandle: FileHandle,
  entry: VerifiedZipFileEntry,
  outputPath: string,
): Promise<void> {
  const output = await open(
    outputPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let written = 0;
  let crc = 0xffffffff;
  try {
    try {
      for await (const chunk of await extractedChunks(archiveHandle, entry)) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        written += bytes.byteLength;
        if (written > entry.uncompressedSize) invalidZip("Zip entry exceeds its declared size");
        crc = updateCrc32(crc, bytes);
        await writeAll(output, bytes);
      }
    } catch (error: unknown) {
      if (isDeflateError(error)) invalidZip("Zip entry decompression failed");
      throw error;
    }
    if (written !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
      invalidZip("Zip entry integrity verification failed");
    }
    await output.sync();
  } catch (error: unknown) {
    await output.close().catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
  await output.close();
}

export async function extractVerifiedZip(
  archiveHandle: FileHandle,
  archive: VerifiedZipArchive,
  buildDir: string,
): Promise<void> {
  await assertArchiveIdentity(archiveHandle, archive.identity);
  for (const entry of archive.entries) {
    const outputPath = join(buildDir, entry.path);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeExtractedEntry(archiveHandle, entry, outputPath);
  }
  await assertArchiveIdentity(archiveHandle, archive.identity);
}
