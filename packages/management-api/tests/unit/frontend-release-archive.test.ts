import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFrontendTarZstd,
  FRONTEND_ARCHIVE_CONTENT_TYPE,
} from "@supacloud/delivery/frontend-archive";
import { readFrontendTarZstd } from "@supacloud/delivery/frontend-archive-reader";
import {
  verifiedFrontendArchive, extractVerifiedFrontendArchive,
} from "../../src/services/frontend-release-archive";
import { FRONTEND_RELEASE_MAX_UNCOMPRESSED_BYTES } from "../../src/services/frontend-release-contract";

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 37) yield bytes.subarray(offset, offset + 37);
}

async function withArchive<T>(bytes: Uint8Array, work: (handle: Awaited<ReturnType<typeof open>>, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "frontend-tar-zstd-test-"));
  const path = join(root, "site.tar.zst");
  await Bun.write(path, bytes);
  const handle = await open(path, "r");
  try {
    return await work(handle, root);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function invalid(bytes: Uint8Array): Promise<void> {
  await withArchive(bytes, async handle => {
    await expect(verifiedFrontendArchive(handle, bytes.byteLength))
      .rejects.toMatchObject({ code: "FRONTEND_RELEASE_ARCHIVE_INVALID", statusCode: 400 });
  });
}

function checksum(tar: Buffer, offset = 0): void {
  tar.fill(0x20, offset + 148, offset + 156);
  const sum = tar.subarray(offset, offset + 512).reduce((total, byte) => total + byte, 0);
  tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, offset + 148, "ascii");
}

async function rawTar(): Promise<Buffer> {
  return Buffer.from(await new Bun.Archive({ "index.html": "ok" }).bytes());
}

describe("verified frontend tar.zst archives", () => {
  test("round trips deterministic files", async () => {
    const files = new Map([
      ["assets/app.js", new TextEncoder().encode("console.log('ok');\n")],
      ["index.html", new TextEncoder().encode("<h1>ok</h1>\n")],
    ]);
    const first = await createFrontendTarZstd(files);
    const second = await createFrontendTarZstd(files);
    expect(Buffer.from(first).equals(second)).toBe(true);
    expect(FRONTEND_ARCHIVE_CONTENT_TYPE).toBe("application/vnd.supacloud.frontend.tar+zstd");
    expect(await readFrontendTarZstd(chunks(first))).toEqual(
      [...files].map(([path, data]) => ({ path, size: data.byteLength })),
    );
  });

  test("extracts regular files only after inventory verification", async () => {
    const bytes = await createFrontendTarZstd(new Map([["index.html", new TextEncoder().encode("ok")]]));
    await withArchive(bytes, async (handle, root) => {
      const output = join(root, "build");
      await mkdir(output);
      const archive = await verifiedFrontendArchive(handle, bytes.byteLength);
      await extractVerifiedFrontendArchive(handle, archive, output);
      expect(await readFile(join(output, "index.html"), "utf8")).toBe("ok");
      await expect(extractVerifiedFrontendArchive(handle, archive, output)).rejects.toThrow();
    });
  });

  test("rejects ZIP, gzip, garbage, truncated zstd, corrupt tar and missing index", async () => {
    await invalid(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]));
    await invalid(Bun.gzipSync(await rawTar()));
    await invalid(new Uint8Array([1, 2, 3]));
    const bytes = await createFrontendTarZstd(new Map([["index.html", new TextEncoder().encode("ok")]]));
    await invalid(bytes.subarray(0, bytes.byteLength - 1));
    const corrupt = await rawTar();
    corrupt[0] ^= 1;
    await invalid(await Bun.zstdCompress(corrupt));
    await invalid(await createFrontendTarZstd(new Map([["assets/app.js", new TextEncoder().encode("js")]])));
    await invalid(await Bun.zstdCompress((await rawTar()).subarray(0, 513)));
  });

  test("rejects unsafe paths on both writer and reader", async () => {
    for (const path of ["../index.html", "/index.html", "C:/index.html", "a\\index.html", "a/../index.html", "./index.html", "a//index.html"]) {
      await expect(createFrontendTarZstd(new Map([
        [path, new TextEncoder().encode("unsafe")],
      ]))).rejects.toThrow("unsafe path");
      const tar = await rawTar();
      tar.fill(0, 0, 100);
      tar.write(path, 0, "utf8");
      checksum(tar);
      await invalid(await Bun.zstdCompress(tar));
    }
  });

  test.each(["1", "2", "3", "4", "5", "6"])("rejects non-regular tar type %s", async type => {
    const tar = await rawTar();
    tar[156] = type.charCodeAt(0);
    checksum(tar);
    await invalid(await Bun.zstdCompress(tar));
  });

  test("rejects duplicate entries and file/directory conflicts in both orders", async () => {
    const tar = await rawTar();
    await invalid(await Bun.zstdCompress(Buffer.concat([tar.subarray(0, 1024), tar])));
    for (const files of [
      { "index.html": "ok", "assets": "file", "assets/app.js": "js" },
      { "index.html": "ok", "assets/app.js": "js", "assets": "file" },
    ]) await invalid(await Bun.zstdCompress(await new Bun.Archive(files).bytes()));
  });

  test("rejects an oversized declaration without allocating its contents", async () => {
    const tar = await rawTar();
    tar.write(`${(FRONTEND_RELEASE_MAX_UNCOMPRESSED_BYTES + 1).toString(8).padStart(11, "0")}\0`, 124, "ascii");
    checksum(tar);
    await invalid(await Bun.zstdCompress(tar));
  });

  test("detects held archive mutation before extracting", async () => {
    const bytes = await createFrontendTarZstd(new Map([["index.html", new TextEncoder().encode("ok")]]));
    await withArchive(bytes, async (handle, root) => {
      const archive = await verifiedFrontendArchive(handle, bytes.byteLength);
      await writeFile(join(root, "site.tar.zst"), bytes.subarray(0, bytes.byteLength - 1));
      await expect(extractVerifiedFrontendArchive(handle, archive, join(root, "build"))).rejects.toThrow("changed");
    });
  });

  test("streams highly compressible files with bounded memory", async () => {
    const fixtureBytes = 8 * 1024 * 1024;
    const bytes = await createFrontendTarZstd(new Map([["index.html", Buffer.alloc(fixtureBytes, 0x61)]]));
    await withArchive(bytes, async (handle, root) => {
      const output = join(root, "build");
      await mkdir(output);
      const initialRss = process.memoryUsage.rss();
      let peakRss = initialRss;
      const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); }, 1);
      try {
        const archive = await verifiedFrontendArchive(handle, bytes.byteLength);
        await extractVerifiedFrontendArchive(handle, archive, output);
        expect(Bun.file(join(output, "index.html")).size).toBe(fixtureBytes);
        expect(peakRss - initialRss).toBeLessThan(64 * 1024 * 1024);
      } finally { clearInterval(sampler); }
    });
  });
});
