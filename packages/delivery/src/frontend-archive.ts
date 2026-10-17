import { pack } from "tar-stream";

export const FRONTEND_ARCHIVE_FORMAT = "tar.zst" as const;
export const FRONTEND_ARCHIVE_RELEASE_SCHEMA = "supacloud.frontend-release.v2" as const;
export const FRONTEND_ARCHIVE_CONTENT_TYPE = "application/vnd.supacloud.frontend.tar+zstd";
export const FRONTEND_ARCHIVE_FILENAME = "archive.tar.zst";
export const FRONTEND_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
export const FRONTEND_ARCHIVE_MAX_FILES = 10_000;
export const FRONTEND_ARCHIVE_MAX_SOURCE_BYTES = 300 * 1024 * 1024;
export const FRONTEND_ARCHIVE_MAX_TAR_BYTES = FRONTEND_ARCHIVE_MAX_SOURCE_BYTES + FRONTEND_ARCHIVE_MAX_FILES * 2048 + 1024;

export interface FrontendArchiveEntry {
  path: string;
  size: number;
}

export function assertFrontendArchivePath(path: string): void {
  if (!path || path.length > 1024 || Buffer.byteLength(path) > 4096 || path.startsWith("/")
    || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split("/").some(segment => !segment || segment === "." || segment === "..")
    || /^[A-Za-z]:/u.test(path)) throw new Error("Frontend archive contains an unsafe path");
}

export async function createFrontendTarZstd(files: ReadonlyMap<string, Uint8Array>): Promise<Buffer> {
  if (typeof Bun === "undefined" || typeof Bun.zstdCompress !== "function") {
    throw new Error("Frontend archive creation requires Bun with zstd support");
  }
  if (files.size < 1 || files.size > FRONTEND_ARCHIVE_MAX_FILES) throw new Error("Frontend archive file count exceeds release limits");
  let sourceBytes = 0;
  const paths = [...files.keys()].sort();
  for (const path of paths) {
    assertFrontendArchivePath(path);
    sourceBytes += files.get(path)!.byteLength;
    if (sourceBytes > FRONTEND_ARCHIVE_MAX_SOURCE_BYTES) throw new Error("Frontend archive exceeds source byte limits");
    const segments = path.split("/");
    segments.pop();
    while (segments.length > 0) {
      if (files.has(segments.join("/"))) throw new Error("Frontend archive contains conflicting paths");
      segments.pop();
    }
  }
  const archive = pack();
  const collected = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of archive) {
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid tar output chunk");
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      size += bytes.byteLength;
      if (size > FRONTEND_ARCHIVE_MAX_TAR_BYTES) throw new Error("Frontend tar exceeds release limits");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  })();
  try {
    for (const path of paths) {
      const content = files.get(path)!;
      await new Promise<void>((resolve, reject) => archive.entry({
        name: path, type: "file", size: content.byteLength, mode: 0o644,
        uid: 0, gid: 0, uname: "", gname: "", mtime: new Date(0),
      }, Buffer.from(content.buffer, content.byteOffset, content.byteLength), error => error ? reject(error) : resolve()));
    }
    archive.finalize();
    const compressed = await Bun.zstdCompress(await collected, { level: 3 });
    if (compressed.byteLength > FRONTEND_ARCHIVE_MAX_BYTES) throw new Error("Frontend compressed archive exceeds release limits");
    return compressed;
  } catch (error: unknown) {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
    await collected.catch(() => undefined);
    throw error;
  }
}
