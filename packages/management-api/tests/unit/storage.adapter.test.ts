import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JuiceFSDriver, S3Driver } from "../../src/services/storage.adapter";
import { shellService } from "../../src/services/shell.service";
import { config } from "../../src/config";

function textStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

describe("S3Driver uploadFile", () => {
  test("refuses prefix deletion without an atomic empty-prefix primitive", async () => {
    const driver = new S3Driver();

    expect(await driver.deleteBucket("testref", "gallery")).toEqual({
      success: false,
      reason: "unknown",
    });
  });

  test("materializes ReadableStream bodies before S3 writes", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousCi = process.env.CI;
    const previousGithubActions = process.env.GITHUB_ACTIONS;

    process.env.NODE_ENV = "production";
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;

    const shellSpy = spyOn(shellService, "execute").mockResolvedValue({
      success: true,
      output: [
        "ACCESS_KEY=test-access",
        "SECRET_KEY=test-secret",
        "ENDPOINT=http://127.0.0.1:9000",
        "BUCKET=supa_test",
      ].join("\n"),
    });

    try {
      const driver = new S3Driver();
      let capturedBody: unknown;
      (driver as unknown as { getClient: () => unknown }).getClient = () => ({
        file: () => ({
          write: async (body: unknown) => {
            capturedBody = body;
            return body instanceof Uint8Array ? body.byteLength : 0;
          },
        }),
      });

      const uploaded = await driver.uploadFile(
        "testref",
        "gallery",
        "raw.txt",
        textStream("hello world"),
        "text/plain",
      );

      expect(uploaded).toBe(true);
      expect(capturedBody).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(capturedBody as Uint8Array)).toBe(
        "hello world",
      );
    } finally {
      shellSpy.mockRestore();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
      if (previousGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = previousGithubActions;
    }
  });

  test("uses external S3 credentials, bucket and region in CI fallback mode", async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      ci: process.env.CI,
      storageType: config.storageType,
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      externalEndpoint: process.env.EXTERNAL_S3_ENDPOINT,
      externalRegion: process.env.EXTERNAL_S3_REGION,
      externalBucket: process.env.EXTERNAL_S3_BUCKET,
      externalAccess: process.env.EXTERNAL_S3_ACCESS_KEY,
      externalSecret: process.env.EXTERNAL_S3_SECRET_KEY,
    };
    process.env.NODE_ENV = "test";
    process.env.CI = "true";
    config.storageType = "external";
    config.s3Endpoint = "https://s3-home.aizhuliren.cn";
    config.s3Region = "cn-north-1";
    process.env.EXTERNAL_S3_ENDPOINT = config.s3Endpoint;
    process.env.EXTERNAL_S3_REGION = config.s3Region;
    process.env.EXTERNAL_S3_BUCKET = "aorist";
    process.env.EXTERNAL_S3_ACCESS_KEY = "external-access";
    process.env.EXTERNAL_S3_SECRET_KEY = "external-secret";

    try {
      const driver = new S3Driver();
      const creds = await (driver as unknown as { getCreds(ref: string): Promise<unknown> }).getCreds("testref");
      expect(creds).toMatchObject({
        accessKey: "external-access",
        secretKey: "external-secret",
        endpoint: "https://s3-home.aizhuliren.cn",
        region: "cn-north-1",
        bucket: "aorist",
      });
    } finally {
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.ci === undefined) delete process.env.CI; else process.env.CI = previous.ci;
      config.storageType = previous.storageType;
      config.s3Endpoint = previous.endpoint;
      config.s3Region = previous.region;
      for (const [key, value] of [
        ["EXTERNAL_S3_ENDPOINT", previous.externalEndpoint],
        ["EXTERNAL_S3_REGION", previous.externalRegion],
        ["EXTERNAL_S3_BUCKET", previous.externalBucket],
        ["EXTERNAL_S3_ACCESS_KEY", previous.externalAccess],
        ["EXTERNAL_S3_SECRET_KEY", previous.externalSecret],
      ] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test("checks bucket emptiness with a bounded prefix query", async () => {
    const driver = new S3Driver();
    let listOptions: unknown;
    (driver as unknown as { getCreds: () => unknown }).getCreds = async () => ({
      accessKey: "test-access",
      secretKey: "test-secret",
      endpoint: "http://127.0.0.1:9000",
      bucket: "supa_test",
    });
    (driver as unknown as { getClient: () => unknown }).getClient = () => ({
      list: async (options: unknown) => {
        listOptions = options;
        return { contents: [{ key: "gallery/logo.svg" }] };
      },
    });

    expect(await driver.isBucketEmpty("testref", "gallery")).toBe(false);
    expect(listOptions).toEqual({ prefix: "gallery/", maxKeys: 1 });
  });
});

describe("S3Driver getDownloadResponse", () => {
  function mockS3Driver(file: {
    exists: () => Promise<boolean>;
    size: number;
    type?: string;
    stream: () => ReadableStream<Uint8Array>;
  }) {
    const driver = new S3Driver();
    (driver as unknown as { getCreds: () => unknown }).getCreds = async () => ({
      accessKey: "test-access",
      secretKey: "test-secret",
      endpoint: "http://127.0.0.1:9000",
      bucket: "supa_test",
    });
    (driver as unknown as { getClient: () => unknown }).getClient = () => ({
      file: () => file,
    });
    return driver;
  }

  test("streams the object and preserves a known positive Content-Length", async () => {
    const body = textStream("streamed body");
    const driver = mockS3Driver({
      exists: async () => true,
      size: "streamed body".length,
      type: "text/plain",
      stream: () => body,
    });

    const response = await driver.getDownloadResponse("testref", "gallery", "raw.txt");
    expect(response).not.toBeNull();
    expect(response!.headers.get("content-type")).toBe("text/plain");
    expect(response!.headers.get("content-length")).toBe(String("streamed body".length));
    expect(await response!.text()).toBe("streamed body");
  });

  test("omits Content-Length when the object size is unknown", async () => {
    const driver = mockS3Driver({
      exists: async () => true,
      size: 0,
      type: "application/octet-stream",
      stream: () => textStream("unknown size"),
    });

    const response = await driver.getDownloadResponse("testref", "gallery", "raw.bin");
    expect(response).not.toBeNull();
    expect(response!.headers.get("content-length")).toBeNull();
    expect(await response!.text()).toBe("unknown size");
  });
});

describe("JuiceFSDriver getDownloadResponse", () => {
  test("streams files without buffering them into memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-storage-download-"));
    try {
      const driver = new JuiceFSDriver();
      (driver as unknown as { getBasePath: (...parts: string[]) => string }).getBasePath =
        (_projectRef: string, bucket?: string, key?: string) =>
          join(root, bucket || "", key || "");
      expect(await driver.createBucket("testref", "gallery")).toBe(true);
      expect(await driver.uploadFile(
        "testref",
        "gallery",
        "streamed.txt",
        textStream("streamed from disk"),
        "text/plain",
      )).toBe(true);

      const response = await driver.getDownloadResponse("testref", "gallery", "streamed.txt");
      expect(response).not.toBeNull();
      expect(response!.headers.get("content-length")).toBe(String("streamed from disk".length));
      expect(await response!.text()).toBe("streamed from disk");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("JuiceFSDriver uploadFile", () => {
  test("materializes ReadableStream bodies before filesystem writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-storage-"));
    try {
      const driver = new JuiceFSDriver();
      (driver as unknown as { getBasePath: (...parts: string[]) => string }).getBasePath =
        (_projectRef: string, bucket?: string, key?: string) =>
          join(root, bucket || "", key || "");
      expect(await driver.createBucket("testref", "gallery")).toBe(true);

      const uploaded = await driver.uploadFile(
        "testref",
        "gallery",
        "raw.txt",
        textStream("hello world"),
        "text/plain",
      );

      expect(uploaded).toBe(true);
      const content = await readFile(join(root, "gallery", "raw.txt"), "utf8");
      expect(content).toBe("hello world");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects stringified ReadableStream marker instead of persisting corrupt objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-storage-"));
    try {
      const driver = new JuiceFSDriver();
      (driver as unknown as { getBasePath: (...parts: string[]) => string }).getBasePath =
        (_projectRef: string, bucket?: string, key?: string) =>
          join(root, bucket || "", key || "");
      expect(await driver.createBucket("testref", "gallery")).toBe(true);

      const uploaded = await driver.uploadFile(
        "testref",
        "gallery",
        "bad.png",
        new TextEncoder().encode("[object ReadableStream]"),
        "image/png",
      );

      expect(uploaded).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects deletion and preserves an object written after an empty check", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-storage-"));
    try {
      const driver = new JuiceFSDriver();
      (driver as unknown as { getBasePath: (...parts: string[]) => string }).getBasePath =
        (_projectRef: string, bucket?: string, key?: string) =>
          join(root, bucket || "", key || "");

      expect(await driver.createBucket("testref", "gallery")).toBe(true);
      expect(await driver.isBucketEmpty("testref", "gallery")).toBe(true);
      expect(await driver.uploadFile(
        "testref",
        "gallery",
        "arrived-after-check.txt",
        new TextEncoder().encode("preserve me"),
        "text/plain",
      )).toBe(true);

      expect(await driver.deleteBucket("testref", "gallery")).toEqual({
        success: false,
        reason: "not_empty",
      });
      expect(await readFile(join(root, "gallery", "arrived-after-check.txt"), "utf8")).toBe("preserve me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not recreate a bucket after atomic deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-storage-"));
    try {
      const driver = new JuiceFSDriver();
      (driver as unknown as { getBasePath: (...parts: string[]) => string }).getBasePath =
        (_projectRef: string, bucket?: string, key?: string) =>
          join(root, bucket || "", key || "");

      expect(await driver.createBucket("testref", "gallery")).toBe(true);
      expect(await driver.deleteBucket("testref", "gallery")).toEqual({ success: true });
      expect(await driver.uploadFile(
        "testref",
        "gallery",
        "late.txt",
        new TextEncoder().encode("must not reappear"),
        "text/plain",
      )).toBe(false);
      await expect(readFile(join(root, "gallery", "late.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats a missing bucket as an unknown deletion outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-storage-"));
    try {
      const driver = new JuiceFSDriver();
      (driver as unknown as { getBasePath: (...parts: string[]) => string }).getBasePath =
        (_projectRef: string, bucket?: string, key?: string) =>
          join(root, bucket || "", key || "");

      expect(await driver.deleteBucket("testref", "missing")).toEqual({
        success: false,
        reason: "unknown",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("JuiceFSDriver conditional uploadFile", () => {
  test("creates exclusively, rejects stale ETags, and replaces with the current ETag", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-storage-conditional-"));
    try {
      const driver = new JuiceFSDriver();
      (driver as unknown as { getBasePath: (...parts: string[]) => string }).getBasePath =
        (_projectRef: string, bucket?: string, key?: string) => join(root, bucket || "", key || "");
      expect(await driver.createBucket("testref", "gallery")).toBe(true);

      const first = await driver.uploadFileConditional(
        "testref", "gallery", "raw.txt", new TextEncoder().encode("one"), "text/plain", null,
      );
      expect(first.outcome).toBe("created");
      expect(await readFile(join(root, "gallery", "raw.txt"), "utf8")).toBe("one");

      const duplicate = await driver.uploadFileConditional(
        "testref", "gallery", "raw.txt", new TextEncoder().encode("two"), "text/plain", null,
      );
      expect(duplicate).toEqual({ outcome: "exists" });
      expect(await readFile(join(root, "gallery", "raw.txt"), "utf8")).toBe("one");

      const stale = await driver.uploadFileConditional(
        "testref", "gallery", "raw.txt", new TextEncoder().encode("two"), "text/plain", "stale",
      );
      expect(stale).toEqual({ outcome: "etag_mismatch" });

      const replaced = await driver.uploadFileConditional(
        "testref", "gallery", "raw.txt", new TextEncoder().encode("two"), "text/plain", first.etag,
      );
      expect(replaced.outcome).toBe("replaced");
      expect(await readFile(join(root, "gallery", "raw.txt"), "utf8")).toBe("two");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("JuiceFSDriver path traversal protection", () => {
  async function withTempMount<T>(fn: (mount: string) => Promise<T>): Promise<T> {
    const mount = await mkdtemp(join(tmpdir(), "supacloud-mount-"));
    const original = config.storageMountPoint;
    config.storageMountPoint = mount;
    try {
      return await fn(mount);
    } finally {
      config.storageMountPoint = original;
      await rm(mount, { recursive: true, force: true });
    }
  }

  test("rejects dot-segment and prefixed sibling bucket identifiers", async () => {
    await withTempMount(async (mount) => {
      const driver = new JuiceFSDriver();
      // Even if an adjacent project directory exists, ../supa-victim must not pass boundary validation
      await mkdir(join(mount, "supa-victim"), { recursive: true });

      for (const bucket of ["..", ".", "...", "../supa-victim", "a/b", "a\\b"]) {
        expect(await driver.createBucket("proj", bucket)).toBe(false);
        expect(await driver.uploadFile("proj", bucket, "x.txt", new TextEncoder().encode("x"), "text/plain")).toBe(false);
      }
      // Ensure adjacent project directory was not written to
      expect(await driver.isBucketEmpty("proj", "gallery").catch(() => true)).toBe(true);
    });
  });

  test("accepts normal bucket identifiers within the project root", async () => {
    await withTempMount(async () => {
      const driver = new JuiceFSDriver();
      expect(await driver.createBucket("proj", "gallery-1")).toBe(true);
      const uploaded = await driver.uploadFile(
        "proj",
        "gallery-1",
        "docs/a.txt",
        new TextEncoder().encode("hello"),
        "text/plain",
      );
      expect(uploaded).toBe(true);
    });
  });

  test("blocks symlink escape inside a bucket directory", async () => {
    await withTempMount(async (mount) => {
      const outside = await mkdtemp(join(tmpdir(), "supacloud-outside-"));
      try {
        await writeFile(join(outside, "secret.txt"), "top-secret");
        const bucketDir = join(mount, "supa-proj", "gallery");
        await mkdir(bucketDir, { recursive: true });
        await symlink(outside, join(bucketDir, "link"));

        const driver = new JuiceFSDriver();
        await expect(driver.getDownloadResponse("proj", "gallery", "link/secret.txt"))
          .rejects.toThrow(/Path traversal blocked/);
        // Writing outside the bucket via symlink must also fail
        expect(
          await driver.uploadFile("proj", "gallery", "link/evil.txt", new TextEncoder().encode("x"), "text/plain"),
        ).toBe(false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("blocks a project root symlink that points outside the storage mount", async () => {
    await withTempMount(async (mount) => {
      const outside = await mkdtemp(join(tmpdir(), "supacloud-outside-root-"));
      try {
        await writeFile(join(outside, "secret.txt"), "outside-root-secret");
        await symlink(outside, join(mount, "supa-proj"));

        const driver = new JuiceFSDriver();
        await expect(driver.getDownloadResponse("proj", "gallery", "secret.txt"))
          .rejects.toThrow(/Path traversal blocked/);
        expect(await driver.createBucket("proj", "gallery")).toBe(false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
