import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  buildSignedPath,
  extractMultipartFileFast,
  getRequestOrigin,
  getUploadMetadata,
  isLoopbackHost,
  normalizeListInteger,
  parseFileSizeLimit,
  readUploadBody,
  signedUrlPayload,
  verifyLegacySignedToken,
} from "../../src/routes/storage-compat.helpers";

describe("storage compatibility helpers", () => {
  test("verifies the legacy HMAC token against the exact tenant object payload", () => {
    const secret = "tenant-signing-secret";
    const expiresAt = 4_000_000_000;
    const payload = signedUrlPayload("project-ref", "avatars", "folder/cat.png", expiresAt);
    const token = createHmac("sha256", secret).update(payload).digest("hex");

    expect(verifyLegacySignedToken(secret, "project-ref", "avatars", "folder/cat.png", token, expiresAt)).toBe(true);
    expect(verifyLegacySignedToken(secret, "other-ref", "avatars", "folder/cat.png", token, expiresAt)).toBe(false);
    expect(verifyLegacySignedToken(secret, "project-ref", "avatars", "folder/cat.png", token, expiresAt, expiresAt + 1)).toBe(false);
  });

  test("extracts multipart bytes and merges metadata with cache control", () => {
    const boundary = "boundary-123";
    const body = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="metadata"',
      "",
      '{"owner":"user-1"}',
      `--${boundary}`,
      'Content-Disposition: form-data; name="cacheControl"',
      "",
      "3600",
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="cat.txt"',
      "Content-Type: text/plain",
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n"));

    const extracted = extractMultipartFileFast(body, boundary);
    expect(extracted?.fileBuffer.toString()).toBe("hello");
    expect(extracted?.mimeType).toBe("text/plain");
    expect(extracted?.metadata).toEqual({ owner: "user-1", cacheControl: "3600" });
  });

  test("streams raw uploads while multipart uploads are parsed", async () => {
    const request = new Request("http://localhost/storage/v1/object/avatars/raw.txt", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "3" },
      body: "abc",
    });

    const body = await readUploadBody(request, "text/plain", "3", 1024);
    expect(body.fileData).toBeInstanceOf(ReadableStream);
    expect(body.fileMimeType).toBe("text/plain");
    expect(body.size).toBe(3);
  });

  test("normalizes request origin, metadata, list integers, and file size limits", () => {
    const request = new Request("http://internal:9090/object", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.example.com",
      },
    });
    const metadata = Buffer.from(JSON.stringify({ owner: "user-1" })).toString("base64");

    expect(getRequestOrigin(request)).toBe("https://api.example.com/storage/v1");
    expect(getUploadMetadata({ "x-metadata": metadata, "cache-control": "max-age=60" }))
      .toEqual({ owner: "user-1", cacheControl: "max-age=60" });
    expect(normalizeListInteger("999", 10, 0, 100)).toBe(100);
    expect(parseFileSizeLimit("1.5mb")).toBe(1_572_864);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(buildSignedPath("/object/sign/a.txt", 123, "token", { width: 64 }, "a.txt"))
      .toBe("/object/sign/a.txt?token=token&expiresAt=123&download=a.txt&width=64");
  });
});
