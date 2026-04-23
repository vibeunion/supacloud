import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { storageRoutes } from "../../src/routes/storage";
import { StorageService } from "../../src/services/storage.service";

const BASE = "http://localhost";
const app = new Elysia().use(storageRoutes);

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`${BASE}${path}`, init));
}

describe("storage management routes", () => {
  test("management upload accepts zero-byte files and honors explicit path", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);
    const formData = new FormData();
    formData.append("file", new Blob([], { type: "text/plain" }), "empty.txt");
    formData.append("path", "nested/empty.txt");

    const res = await request("/v1/storage/test-ref/buckets/manuals/upload", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
    const [projectRef, bucket, objectPath, fileData, mimeType] = uploadSpy.mock.calls.at(-1)!;
    expect(projectRef).toBe("test-ref");
    expect(bucket).toBe("manuals");
    expect(objectPath).toBe("nested/empty.txt");
    expect(fileData).toBeTruthy();
    expect(String(mimeType)).toContain("text/plain");
    uploadSpy.mockRestore();
  });

  test("management raw upload streams large files to explicit object path", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);

    const res = await request("/v1/storage/test-ref/buckets/manuals/files/nested/large.bin", {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "3",
      },
      body: "abc",
    });

    expect(res.status).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
    const [projectRef, bucket, objectPath, fileData, mimeType] = uploadSpy.mock.calls.at(-1)!;
    expect(projectRef).toBe("test-ref");
    expect(bucket).toBe("manuals");
    expect(objectPath).toBe("nested/large.bin");
    expect(fileData).toBeTruthy();
    expect(typeof (fileData as ReadableStream).getReader).toBe("function");
    expect(String(mimeType)).toContain("application/octet-stream");
    uploadSpy.mockRestore();
  });
});
