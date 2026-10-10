import type { FileHandle } from "node:fs/promises";
import { readFrontendTarZstd } from "@supacloud/delivery/frontend-archive-reader";
import { frontendReleaseError } from "./frontend-release-contract";

const ARCHIVE_CHUNK_BYTES = 64 * 1024;

export interface VerifiedFrontendFileEntry {
  path: string;
  uncompressedSize: number;
}

interface ArchiveIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface VerifiedFrontendArchive {
  readonly size: number;
  readonly identity: ArchiveIdentity;
  readonly entries: readonly VerifiedFrontendFileEntry[];
}

function invalidArchive(message: string): never {
  throw frontendReleaseError("FRONTEND_RELEASE_ARCHIVE_INVALID", 400, message);
}

function archiveIdentity(metadata: Awaited<ReturnType<FileHandle["stat"]>>): ArchiveIdentity {
  if (!metadata.isFile()) invalidArchive("Frontend release archive must be a regular file");
  return {
    dev: Number(metadata.dev), ino: Number(metadata.ino), size: Number(metadata.size),
    mtimeMs: Number(metadata.mtimeMs), ctimeMs: Number(metadata.ctimeMs),
  };
}

async function assertArchiveIdentity(handle: FileHandle, expected: ArchiveIdentity): Promise<void> {
  const current = archiveIdentity(await handle.stat());
  if (Object.keys(expected).some(key => expected[key as keyof ArchiveIdentity] !== current[key as keyof ArchiveIdentity])) {
    invalidArchive("Frontend release archive changed while it was verified");
  }
}

async function* archiveChunks(handle: FileHandle, size: number): AsyncGenerator<Uint8Array> {
  let offset = 0;
  while (offset < size) {
    const bytes = Buffer.allocUnsafe(Math.min(ARCHIVE_CHUNK_BYTES, size - offset));
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, offset);
    if (bytesRead === 0) invalidArchive("Frontend release archive is truncated");
    offset += bytesRead;
    yield bytes.subarray(0, bytesRead);
  }
}

async function readArchive(
  handle: FileHandle,
  size: number,
  outputDirectory?: string,
): Promise<VerifiedFrontendFileEntry[]> {
  try {
    const entries = await readFrontendTarZstd(archiveChunks(handle, size), outputDirectory);
    if (!entries.some(entry => entry.path === "index.html")) {
      invalidArchive("Frontend release archive must contain index.html");
    }
    return entries.map(entry => ({ path: entry.path, uncompressedSize: entry.size }));
  } catch (error: unknown) {
    invalidArchive(error instanceof Error ? error.message : "Frontend release tar.zst is invalid");
  }
}

export async function verifiedFrontendArchive(
  handle: FileHandle,
  archiveSize: number,
): Promise<VerifiedFrontendArchive> {
  const identity = archiveIdentity(await handle.stat());
  if (identity.size !== archiveSize || archiveSize < 1) invalidArchive("Frontend release archive size is invalid");
  const entries = await readArchive(handle, archiveSize);
  await assertArchiveIdentity(handle, identity);
  return { size: archiveSize, identity, entries };
}

export async function extractVerifiedFrontendArchive(
  handle: FileHandle,
  archive: VerifiedFrontendArchive,
  buildDirectory: string,
): Promise<void> {
  await assertArchiveIdentity(handle, archive.identity);
  const entries = await readArchive(handle, archive.size, buildDirectory);
  if (JSON.stringify(entries) !== JSON.stringify(archive.entries)) {
    invalidArchive("Frontend release archive inventory changed while extracting");
  }
  await assertArchiveIdentity(handle, archive.identity);
}
