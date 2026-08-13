import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractVerifiedZip,
  verifiedZipArchive,
  type VerifiedZipFileEntry,
} from "../../src/services/frontend-release-archive";
import { FrontendReleaseError } from "../../src/services/frontend-release-contract";

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

function endOffset(archive: Uint8Array): number {
  const view = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw new Error("fixture has no zip end record");
}

function firstCentralOffset(archive: Uint8Array): number {
  const view = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const offset = view.readUInt32LE(endOffset(archive) + 16);
  if (view.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error("fixture has no central record");
  return offset;
}

async function zipFixture(entries: Record<string, string>): Promise<Uint8Array> {
  const base = join(tmpdir(), `frontend-release-archive-${crypto.randomUUID()}`);
  await Bun.$`mkdir -p ${base}`;
  for (const [path, contents] of Object.entries(entries)) {
    const absolutePath = join(base, path);
    await Bun.$`mkdir -p ${join(absolutePath, "..")} `.quiet();
    await writeFile(absolutePath, contents);
  }
  const archivePath = `${base}.zip`;
  const zipped = await Bun.$`zip -q -X -r ${archivePath} .`.cwd(base).nothrow();
  if (zipped.exitCode !== 0) throw new Error("zip fixture failed");
  const archive = new Uint8Array(await readFile(archivePath));
  await Bun.$`chmod -R u+w ${base}`.nothrow();
  await Bun.$`rm -r ${base} ${archivePath}`.nothrow();
  return archive;
}

async function verifiedEntries(archive: Uint8Array): Promise<readonly VerifiedZipFileEntry[]> {
  const archivePath = join(tmpdir(), `frontend-release-read-${crypto.randomUUID()}.zip`);
  await writeFile(archivePath, archive);
  const handle = await open(archivePath, "r");
  try {
    return (await verifiedZipArchive(handle, archive.byteLength)).entries;
  } finally {
    await handle.close();
    await unlink(archivePath);
  }
}

async function expectInvalid(archive: Uint8Array): Promise<void> {
  try {
    await verifiedEntries(archive);
    throw new Error("Expected invalid zip archive");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(FrontendReleaseError);
    expect(error).toMatchObject({ code: "FRONTEND_RELEASE_ARCHIVE_INVALID", statusCode: 400 });
  }
}

function dataDescriptorFixture(source: Uint8Array, centralIndex = 0): Uint8Array {
  const sourceView = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const sourceCentralDirectory = firstCentralOffset(source);
  let sourceCentral = sourceCentralDirectory;
  for (let index = 0; index < centralIndex; index += 1) {
    sourceCentral += 46 + sourceView.readUInt16LE(sourceCentral + 28)
      + sourceView.readUInt16LE(sourceCentral + 30) + sourceView.readUInt16LE(sourceCentral + 32);
  }
  const localOffset = sourceView.readUInt32LE(sourceCentral + 42);
  const compressedSize = sourceView.readUInt32LE(sourceCentral + 20);
  const localNameLength = sourceView.readUInt16LE(localOffset + 26);
  const localExtraLength = sourceView.readUInt16LE(localOffset + 28);
  const dataEnd = localOffset + 30 + localNameLength + localExtraLength + compressedSize;
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(sourceView.readUInt32LE(sourceCentral + 16), 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(sourceView.readUInt32LE(sourceCentral + 24), 12);
  const archive = Buffer.concat([
    sourceView.subarray(0, dataEnd),
    descriptor,
    sourceView.subarray(dataEnd),
  ]);
  const central = sourceCentral + descriptor.byteLength;
  const firstCentral = sourceCentralDirectory + descriptor.byteLength;
  const end = endOffset(archive);
  archive.writeUInt16LE(archive.readUInt16LE(localOffset + 6) | 0x0008, localOffset + 6);
  archive.writeUInt32LE(0, localOffset + 14);
  archive.writeUInt32LE(0, localOffset + 18);
  archive.writeUInt32LE(0, localOffset + 22);
  archive.writeUInt16LE(archive.readUInt16LE(central + 8) | 0x0008, central + 8);
  archive.writeUInt32LE(firstCentral, end + 16);
  let centralCursor = firstCentral;
  while (centralCursor < end) {
    const shiftedLocalOffset = archive.readUInt32LE(centralCursor + 42);
    if (shiftedLocalOffset >= dataEnd) {
      archive.writeUInt32LE(shiftedLocalOffset + descriptor.byteLength, centralCursor + 42);
    }
    centralCursor += 46 + archive.readUInt16LE(centralCursor + 28)
      + archive.readUInt16LE(centralCursor + 30) + archive.readUInt16LE(centralCursor + 32);
  }
  return new Uint8Array(archive);
}

describe("verified frontend release archives", () => {
  test("accepts a bounded static site with an index", async () => {
    const archive = await zipFixture({ "index.html": "ok", "assets/app.js": "js" });
    expect((await verifiedEntries(archive)).map((entry) => entry.path).sort()).toEqual([
      "assets/app.js",
      "index.html",
    ]);
  });

  test("rejects encrypted, ZIP64, overlapping, duplicate, traversal, and non-regular metadata", async () => {
    const source = await zipFixture({ "index.html": "ok" });
    const encrypted = source.slice();
    Buffer.from(encrypted.buffer).writeUInt16LE(1, firstCentralOffset(encrypted) + 8);
    await expectInvalid(encrypted);

    const zip64 = source.slice();
    Buffer.from(zip64.buffer).writeUInt32LE(0xffffffff, endOffset(zip64) + 16);
    await expectInvalid(zip64);

    const overlap = source.slice();
    const overlapView = Buffer.from(overlap.buffer);
    const central = firstCentralOffset(overlap);
    overlapView.writeUInt32LE(central - 1, central + 20);
    await expectInvalid(overlap);

    const duplicate = source.slice();
    const duplicateView = Buffer.from(duplicate.buffer);
    const duplicateEnd = endOffset(duplicate);
    duplicateView.writeUInt16LE(2, duplicateEnd + 8);
    duplicateView.writeUInt16LE(2, duplicateEnd + 10);
    await expectInvalid(duplicate);

    const traversal = source.slice();
    const traversalView = Buffer.from(traversal.buffer);
    const traversalCentral = firstCentralOffset(traversal);
    const nameLength = traversalView.readUInt16LE(traversalCentral + 28);
    const unsafeName = "../evil.ht";
    expect(Buffer.byteLength(unsafeName)).toBe(nameLength);
    traversalView.write(unsafeName, traversalCentral + 46, "utf8");
    const localOffset = traversalView.readUInt32LE(traversalCentral + 42);
    traversalView.write(unsafeName, localOffset + 30, "utf8");
    await expectInvalid(traversal);

    const symlink = source.slice();
    const symlinkView = Buffer.from(symlink.buffer);
    const symlinkCentral = firstCentralOffset(symlink);
    symlinkView.writeUInt16LE(3 << 8, symlinkCentral + 4);
    symlinkView.writeUInt32LE(0o120777 * 65_536, symlinkCentral + 38);
    await expectInvalid(symlink);
  });

  test("accepts a valid data descriptor and rejects descriptor corruption", async () => {
    const descriptor = dataDescriptorFixture(await zipFixture({ "index.html": "ok" }));
    expect((await verifiedEntries(descriptor))[0].recordEnd).toBe(firstCentralOffset(descriptor));

    const corrupted = descriptor.slice();
    const entry = (await verifiedEntries(corrupted))[0];
    Buffer.from(corrupted.buffer).writeUInt32LE(0, entry.dataEnd + 4);
    await expectInvalid(corrupted);
  });

  test("rejects a second local record that overlaps the first data descriptor", async () => {
    const descriptor = dataDescriptorFixture(await zipFixture({
      "index.html": "ok",
      "second.txt": "second",
    }), 1);
    const entries = await verifiedEntries(descriptor);
    expect(entries).toHaveLength(2);
    const archive = descriptor.slice();
    const central = firstCentralOffset(archive);
    const view = Buffer.from(archive.buffer);
    const firstCentralNameLength = view.readUInt16LE(central + 28);
    const firstCentralExtraLength = view.readUInt16LE(central + 30);
    const firstCentralCommentLength = view.readUInt16LE(central + 32);
    const secondCentral = central + 46 + firstCentralNameLength
      + firstCentralExtraLength + firstCentralCommentLength;
    view.writeUInt32LE(entries[1].dataEnd, central + 42);
    await expectInvalid(archive);
  });

  test("streams extraction and rejects CRC or deflate corruption", async () => {
    const source = await zipFixture({ "index.html": "streamed-content".repeat(1024) });
    const archivePath = join(tmpdir(), `frontend-release-extract-${crypto.randomUUID()}.zip`);
    const buildDir = await mkdtemp(join(tmpdir(), "frontend-release-build-"));
    await writeFile(archivePath, source);
    const handle = await open(archivePath, "r");
    try {
      const verified = await verifiedZipArchive(handle, source.byteLength);
      await extractVerifiedZip(handle, verified, buildDir);
      expect((await readFile(join(buildDir, "index.html"), "utf8")).startsWith("streamed-content")).toBe(true);
    } finally {
      await handle.close();
      await unlink(archivePath);
      await rm(buildDir, { recursive: true, force: true });
    }

    for (const corrupt of ["crc", "deflate"] as const) {
      const archive = source.slice();
      const view = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
      const central = firstCentralOffset(archive);
      if (corrupt === "crc") {
        view.writeUInt32LE((view.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
        const local = view.readUInt32LE(central + 42);
        view.writeUInt32LE(view.readUInt32LE(central + 16), local + 14);
      } else {
        const local = view.readUInt32LE(central + 42);
        const dataOffset = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
        view[dataOffset] ^= 0xff;
      }
      const corruptPath = join(tmpdir(), `frontend-release-corrupt-${crypto.randomUUID()}.zip`);
      const outputDir = await mkdtemp(join(tmpdir(), "frontend-release-corrupt-build-"));
      await writeFile(corruptPath, archive);
      const corruptHandle = await open(corruptPath, "r");
      try {
        const verified = await verifiedZipArchive(corruptHandle, archive.byteLength);
        await expect(extractVerifiedZip(corruptHandle, verified, outputDir))
          .rejects.toMatchObject({ code: "FRONTEND_RELEASE_ARCHIVE_INVALID" });
      } finally {
        await corruptHandle.close();
        await unlink(corruptPath);
        await rm(outputDir, { recursive: true, force: true });
      }
    }
  });

  test("extracts highly compressible content without materializing the entry", async () => {
    const base = await mkdtemp(join(tmpdir(), "frontend-release-compressed-"));
    const archivePath = `${base}.zip`;
    const buildDir = `${base}-build`;
    await writeFile(join(base, "index.html"), Buffer.alloc(32 * 1024 * 1024, 0x61));
    const zipped = await Bun.$`zip -q -X ${archivePath} index.html`.cwd(base).nothrow();
    if (zipped.exitCode !== 0) throw new Error("zip fixture failed");
    await mkdir(buildDir);
    const handle = await open(archivePath, "r");
    const archiveSize = (await handle.stat()).size;
    const startingRss = process.memoryUsage.rss();
    let peakRss = startingRss;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
    }, 1);
    try {
      const verified = await verifiedZipArchive(handle, archiveSize);
      await extractVerifiedZip(handle, verified, buildDir);
      expect((await readFile(join(buildDir, "index.html"))).byteLength).toBe(32 * 1024 * 1024);
      expect(peakRss - startingRss).toBeLessThan(64 * 1024 * 1024);
    } finally {
      clearInterval(sample);
      await handle.close();
      await rm(base, { recursive: true, force: true });
      await rm(archivePath, { force: true });
      await rm(buildDir, { recursive: true, force: true });
    }
  });
});
