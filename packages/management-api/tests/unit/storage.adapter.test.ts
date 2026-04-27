import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JuiceFSDriver, S3Driver } from "../../src/services/storage.adapter";
import { shellService } from "../../src/services/shell.service";

function textStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

describe("S3Driver uploadFile", () => {
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
});

describe("JuiceFSDriver uploadFile", () => {
  test("materializes ReadableStream bodies before filesystem writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-storage-"));
    try {
      const driver = new JuiceFSDriver();
      (driver as unknown as { getBasePath: (...parts: string[]) => string }).getBasePath =
        (_projectRef: string, bucket?: string, key?: string) =>
          join(root, bucket || "", key || "");

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
});
