import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { storageCompatRoutes } from "../../src/routes/storage-compat";
import { mockBuckets, mockObjects } from "../../src/services/storage-rls";
import { StorageService } from "../../src/services/storage.service";
import { SignedStore, TusStore } from "../../src/services/storage-store";

const BASE = "http://localhost";

const testApp = new Elysia({ prefix: "/storage/v1" }).use(storageCompatRoutes);

function request(path: string, init?: RequestInit) {
  return testApp.handle(new Request(`${BASE}${path}`, init));
}

beforeEach(() => {
  mockBuckets.clear();
  mockObjects.clear();
  config.storageSigningSecret = "test-storage-signing-secret";

  spyOn(SignedStore, "set").mockResolvedValue(undefined);
  spyOn(SignedStore, "get").mockResolvedValue({ ref: "test_mock", bucket: "avatars", objectName: "signed.txt", upsert: false, expiresAt: 4000000000 });
  spyOn(SignedStore, "delete").mockResolvedValue(undefined);
  spyOn(TusStore, "get").mockResolvedValue(null);

  mockBuckets.set("avatars", {
    id: "avatars",
    name: "avatars",
    public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    file_size_limit: null,
    allowed_mime_types: null,
  });
});

afterEach(() => {
  mockBuckets.clear();
  mockObjects.clear();
});

describe("storageCompatRoutes supabase-js compatibility", () => {
  test("createSignedUrl returns an SDK-relative path and signed download works", async () => {
    mockObjects.set("avatars/folder/cat.png", {
      metadata: { size: 3, mimetype: "image/png" },
      updated: new Date().toISOString(),
    });

    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("png", {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "3",
        },
      })
    );

    const signRes = await request("/storage/v1/object/sign/avatars/folder/cat.png", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 60 }),
    });

    expect(signRes.status).toBe(200);
    const signed = await signRes.json();
    expect(signed.signedURL).toStartWith("/object/sign/avatars/folder/cat.png?");
    expect(signed.signedURL).not.toContain("/storage/v1/object/sign");

    const fileRes = await request(`/storage/v1${signed.signedURL}`, {
      headers: { apikey: "test-token" },
    });

    expect(fileRes.status).toBe(200);
    expect(await fileRes.text()).toBe("png");
    downloadSpy.mockRestore();
  });

  test("signed transform url keeps advanced imaginary options", async () => {
    mockObjects.set("avatars/folder/hero.png", {
      metadata: { size: 3, mimetype: "image/png" },
      updated: new Date().toISOString(),
    });

    const res = await request("/storage/v1/object/sign/avatars/folder/hero.png", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expiresIn: 60,
        transform: {
          width: 256,
          height: 256,
          smartcrop: true,
          watermark: "ACME",
          blur: 4,
          wm_opacity: 0.4,
        },
      }),
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.signedURL).toContain("/render/image/sign/avatars/folder/hero.png?");
    expect(payload.signedURL).toContain("smartcrop=true");
    expect(payload.signedURL).toContain("watermark=ACME");
    expect(payload.signedURL).toContain("blur=4");
    expect(payload.signedURL).toContain("wm_opacity=0.4");
  });

  test("signed upload flow matches createSignedUploadUrl + uploadToSignedUrl", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);

    const signRes = await request("/storage/v1/object/upload/sign/avatars/signed.txt", {
      method: "POST",
      headers: { apikey: "test-token" },
    });

    expect(signRes.status).toBe(200);
    const signed = await signRes.json();
    expect(signed.url).toStartWith("/object/upload/sign/avatars/signed.txt?token=");
    expect(signed.url).not.toContain("&t=");

    const uploadRes = await request(`/storage/v1${signed.url}`, {
      method: "PUT",
      headers: {
        apikey: "test-token",
        "content-type": "text/plain",
      },
      body: "hello world",
    });

    expect(uploadRes.status).toBe(200);
    expect(await uploadRes.json()).toEqual({ Key: "avatars/signed.txt" });
    expect(uploadSpy).toHaveBeenCalled();
    // Fix-2: Verify the signed upload token was consumed (one-time use)
    expect(SignedStore.delete).toHaveBeenCalled();
    uploadSpy.mockRestore();
  });

  test("multipart zero-byte upload is accepted", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);
    const formData = new FormData();
    formData.append("file", new Blob([], { type: "text/plain" }), "empty.txt");

    const res = await request("/storage/v1/object/avatars/empty.txt", {
      method: "POST",
      headers: {
        apikey: "test-token",
      },
      body: formData,
    });

    expect(res.status).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
    uploadSpy.mockRestore();
  });

  test("raw object upload forwards a stream for non-multipart bodies", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);

    const res = await request("/storage/v1/object/avatars/raw.txt", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "text/plain",
        "content-length": "3",
      },
      body: "abc",
    });

    expect(res.status).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
    const streamArg = uploadSpy.mock.calls.at(-1)?.[3] as ReadableStream | undefined;
    expect(streamArg).toBeDefined();
    expect(typeof (streamArg as ReadableStream).getReader).toBe("function");
    uploadSpy.mockRestore();
  });

  test("duplicate upload without upsert is rejected", async () => {
    mockObjects.set("avatars/existing.txt", {
      metadata: { size: 5, mimetype: "text/plain" },
      updated: new Date().toISOString(),
    });

    const res = await request("/storage/v1/object/avatars/existing.txt", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "text/plain",
      },
      body: "hello",
    });

    expect(res.status).toBe(409);
  });

  test("generic authenticated download path works for sdk download()", async () => {
    mockObjects.set("avatars/private.txt", {
      metadata: { size: 7, mimetype: "text/plain" },
      updated: new Date().toISOString(),
    });

    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("private", {
        headers: {
          "Content-Type": "text/plain",
        },
      })
    );

    const res = await request("/storage/v1/object/avatars/private.txt", {
      headers: { apikey: "test-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("private");
    downloadSpy.mockRestore();
  });

  test("list-v2 supports prefix filtering and search", async () => {
    mockObjects.set("avatars/folder/a.txt", {
      metadata: { size: 1, mimetype: "text/plain" },
      updated: "2024-01-01T00:00:00.000Z",
    });
    mockObjects.set("avatars/folder/b.txt", {
      metadata: { size: 2, mimetype: "text/plain" },
      updated: "2024-01-02T00:00:00.000Z",
    });
    mockObjects.set("avatars/other.txt", {
      metadata: { size: 3, mimetype: "text/plain" },
      updated: "2024-01-03T00:00:00.000Z",
    });

    const res = await request("/storage/v1/object/list-v2/avatars", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prefix: "folder/",
        search: "b",
        sortBy: { column: "name", order: "asc" },
      }),
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.nextCursor).toBeNull();
    expect(payload.objects).toHaveLength(1);
    expect(payload.objects[0].name).toBe("b.txt");
  });
});
