import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProjectConfig } from "../src/runtime/node/load-config.js";
import { transformImage } from "../src/runtime/storage/image-transform.js";
import { StorageHandler } from "../src/runtime/storage/handler.js";

const limit = 500 * 1024 * 1024;

test("image declared-size boundary accepts 500 MiB and rejects the next byte", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=",
    "base64",
  );
  const options = { resize: "contain", format: "png" } as const;
  expect((await transformImage(png, options, limit)).ok).toBe(true);
  expect(await transformImage(png, options, limit + 1)).toMatchObject({
    ok: false, status: 413, message: `The source image exceeds the transformation limit (${limit} bytes)`,
  });
  class OversizedBlob extends Blob {
    override get size() { return limit + 1; }
  }
  expect(await transformImage(new OversizedBlob(), options, 1)).toMatchObject({ ok: false, status: 413 });
});

test("Lite config exposes separate operator-owned image limits", async () => {
  const root = await mkdtemp(join(process.cwd(), ".conversion-config-"));
  try {
    await mkdir(join(root, "supabase"));
    const path = join(root, "supabase/config.toml");
    await writeFile(path, [
      "[storage.image_transformation]",
      'max_input_bytes = "128MiB"',
      'max_output_bytes = "256MiB"',
    ].join("\n"));
    const config = loadProjectConfig(root);
    expect(config.storage.imageTransformLimits).toEqual({
      maxInputBytes: 128 * 1024 * 1024, maxOutputBytes: 256 * 1024 * 1024,
    });
    for (const key of ["max_input_bytes", "max_output_bytes"]) {
      for (const value of ['"bad"', "0", "-1", String(limit + 1), "true", "[]"]) {
        await writeFile(path, `[storage.image_transformation]\n${key} = ${value}\n`);
        expect(() => loadProjectConfig(root, {})).toThrow("image transformation");
      }
    }
    await writeFile(path, "");
    expect(loadProjectConfig(root, {}).storage.imageTransformLimits).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Lite Storage defaults an unset bucket limit to 500 MiB", () => {
  const handler = new StorageHandler(null as never, {
    put: async () => {}, get: async () => null, delete: async () => {}, deleteMany: async () => {},
  }, { jwtSecret: "test" });
  const boundary = handler as unknown as {
    effectiveFileSizeLimit(bucket: { file_size_limit: number | string | null }): number;
  };
  expect(boundary.effectiveFileSizeLimit({ file_size_limit: null })).toBe(limit);
  expect(boundary.effectiveFileSizeLimit({ file_size_limit: 1024 })).toBe(1024);
  expect(boundary.effectiveFileSizeLimit({ file_size_limit: "2048" })).toBe(2048);
  const configured = new StorageHandler(null as never, {
    put: async () => {}, get: async () => null, delete: async () => {}, deleteMany: async () => {},
  }, { jwtSecret: "test", defaultFileSizeLimit: 4096 }) as unknown as typeof boundary;
  expect(configured.effectiveFileSizeLimit({ file_size_limit: null })).toBe(4096);
  expect(configured.effectiveFileSizeLimit({ file_size_limit: 1024 })).toBe(1024);
});

test("Storage Handler applies captured input and output limits separately", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=", "base64",
  );
  for (const limits of [
    { maxInputBytes: 1, maxOutputBytes: limit }, { maxInputBytes: limit, maxOutputBytes: 1 },
  ]) {
    const handler = new StorageHandler(null as never, {
      put: async () => {}, get: async () => png, delete: async () => {}, deleteMany: async () => {},
    }, { jwtSecret: "test", imageTransformLimits: limits });
    const isInput = limits.maxInputBytes === 1;
    limits.maxInputBytes = limit;
    limits.maxOutputBytes = limit;
    const boundary = handler as unknown as {
      transformImageResponse(row: unknown, url: URL, head: boolean): Promise<Response>;
    };
    const response = await boundary.transformImageResponse({
      id: "id", bucket_id: "images", name: "test.png", owner: null, version: null,
      metadata: { size: png.byteLength, mimetype: "image/png" },
    }, new URL("https://image.test.invalid?format=png"), false);
    expect(response.status).toBe(413);
    expect(await response.text()).toContain(isInput
      ? "source image exceeds the transformation limit (1 bytes)"
      : "transformed image exceeds the transformation limit (1 bytes)");
  }
});

test("Storage Handler rejects a declared oversized image before reading object bytes", async () => {
  let reads = 0;
  const handler = new StorageHandler(null as never, {
    put: async () => {}, get: async () => { reads++; return new Uint8Array(); },
    delete: async () => {}, deleteMany: async () => {},
  }, { jwtSecret: "test", imageTransformLimits: { maxInputBytes: 1, maxOutputBytes: limit } });
  const boundary = handler as unknown as {
    transformImageResponse(row: unknown, url: URL, head: boolean): Promise<Response>;
  };
  const response = await boundary.transformImageResponse({
    id: "id", bucket_id: "images", name: "large.png", owner: null, version: null,
    metadata: { size: 2, mimetype: "image/png" },
  }, new URL("https://image.test.invalid?format=png"), false);
  expect(response.status).toBe(413);
  expect(reads).toBe(0);
});
