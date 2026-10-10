import { extract } from "tar-stream";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zstdConstants, createZstdDecompress } from "node:zlib";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertFrontendArchivePath, FRONTEND_ARCHIVE_MAX_BYTES, FRONTEND_ARCHIVE_MAX_FILES,
  FRONTEND_ARCHIVE_MAX_SOURCE_BYTES, FRONTEND_ARCHIVE_MAX_TAR_BYTES,
  type FrontendArchiveEntry,
} from "./frontend-archive";

export async function readFrontendTarZstd(
  source: AsyncIterable<Uint8Array>,
  outputDirectory?: string,
): Promise<FrontendArchiveEntry[]> {
  const parser = extract();
  const entries: FrontendArchiveEntry[] = [];
  const paths = new Set<string>();
  const ancestors = new Set<string>();
  let sourceBytes = 0;
  let entryWork: Promise<void> = Promise.resolve();
  parser.on("entry", (header, stream, next) => {
    // 拒绝头信息时尚未开始消费条目流，失败由外层 pipeline 统一接收。
    stream.on("error", () => undefined);
    const consume = async () => {
      const path = header.name;
      assertFrontendArchivePath(path);
      if (header.type !== "file" || header.linkname || !Number.isSafeInteger(header.size)
        || Number(header.size) < 0) throw new Error("Frontend archive contains a non-regular file");
      if (paths.has(path)) throw new Error("Frontend archive contains duplicate paths");
      const size = Number(header.size);
      sourceBytes += size;
      if (paths.size >= FRONTEND_ARCHIVE_MAX_FILES || sourceBytes > FRONTEND_ARCHIVE_MAX_SOURCE_BYTES) {
        throw new Error("Frontend archive exceeds release limits");
      }
      if (ancestors.has(path)) throw new Error("Frontend archive contains conflicting paths");
      const segments = path.split("/");
      segments.pop();
      while (segments.length > 0) {
        const ancestor = segments.join("/");
        if (paths.has(ancestor)) throw new Error("Frontend archive contains conflicting paths");
        ancestors.add(ancestor);
        segments.pop();
      }
      paths.add(path);
      const outputPath = outputDirectory ? join(outputDirectory, path) : null;
      let output: Awaited<ReturnType<typeof open>> | undefined;
      let readBytes = 0;
      try {
        if (outputPath) {
          await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
          output = await open(outputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT
            | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        }
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array)) throw new Error("Invalid tar entry chunk");
          const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          readBytes += bytes.byteLength;
          if (readBytes > size) throw new Error("Frontend archive entry exceeds its declared size");
          if (output) {
            let offset = 0;
            while (offset < bytes.byteLength) {
              const { bytesWritten } = await output.write(bytes, offset, bytes.byteLength - offset);
              if (bytesWritten === 0) throw new Error("Frontend extraction write made no progress");
              offset += bytesWritten;
            }
          }
        }
        if (readBytes !== size) throw new Error("Frontend archive entry is truncated");
        await output?.sync();
      } catch (error: unknown) {
        if (output) {
          await output.close().catch(() => undefined);
          output = undefined;
          await unlink(outputPath!).catch(() => undefined);
        }
        throw error;
      } finally {
        await output?.close();
      }
      entries.push({ path, size });
      next();
    };
    entryWork = consume().catch((error: unknown) => {
      parser.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  const byteLimit = (maximum: number) => {
    let size = 0;
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        callback(size > maximum ? new Error("Frontend archive exceeds byte limits") : null, chunk);
      },
    });
  };
  // Bun 整块解压暂不支持输出上限，远端输入必须先限制窗口和流输出。
  try {
    await pipeline(
      Readable.from(source), byteLimit(FRONTEND_ARCHIVE_MAX_BYTES),
      createZstdDecompress({ params: { [zstdConstants.ZSTD_d_windowLogMax]: 27 } }),
      byteLimit(FRONTEND_ARCHIVE_MAX_TAR_BYTES), parser,
    );
  } finally {
    await entryWork;
  }
  if (entries.length < 1) throw new Error("Frontend archive is empty");
  return entries;
}
