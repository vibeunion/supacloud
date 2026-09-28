// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import * as adapter from "../../src/services/storage.adapter";
import { StorageRLS } from "../../src/services/storage-rls";
import { storageRoutes } from "../../src/routes/storage";
import { projectControlSecretsService } from "../../src/services/project-control-secrets.service";
import { PROJECT_STORAGE_SECRET, ProjectStorageError } from "../../src/services/project-storage-contract";

test("generic control-secret APIs cannot modify, remove or read the storage binding", async () => {
  const { scope, name } = PROJECT_STORAGE_SECRET;
  await expect(projectControlSecretsService.upsert("projecta", scope, name, "replacement")).rejects.toThrow("project storage configuration endpoint");
  await expect(projectControlSecretsService.remove("projecta", scope, name)).rejects.toThrow("project storage configuration endpoint");
  await expect(projectControlSecretsService.readValue("projecta", scope, name)).rejects.toThrow("project storage configuration endpoint");
});

test("image transforms resolve the project backend after authorization and redact upstream failures", async () => {
  const seen: string[] = [];
  const signed = "https://project-a.example.test/physical/root/images/photo.png?X-Amz-Signature=private";
  const source = spyOn(adapter, "getStorageDriver").mockReturnValue({
    getInternalSourceUrl: async (ref: string, bucket: string, key: string) => {
      seen.push(`${ref}/${bucket}/${key}`); return signed;
    },
  } as adapter.StorageDriver);
  const bucket = spyOn(StorageRLS, "getLogicalBucket").mockResolvedValue({ id: "images", name: "images", public: true });
  let upstreamOk = true;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("url")).toBe(signed);
    return upstreamOk ? new Response("image", { headers: { "content-type": "image/png" } })
      : new Response(`upstream leaked ${signed}`, { status: 500 });
  });
  try {
    const app = new Elysia().use(storageRoutes);
    const url = "http://localhost/v1/storage/projecta/transform/thumbnail/images/photo.png";
    const response = await app.handle(new Request(url));
    expect(response.status).toBe(200);
    expect(seen).toEqual(["projecta/images/photo.png"]);
    upstreamOk = false;
    const failed = await app.handle(new Request(url));
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("X-Amz-Signature");
    source.mockReturnValue({ getInternalSourceUrl: async () => { throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE"); } } as adapter.StorageDriver);
    const unavailable = await app.handle(new Request(url));
    expect(unavailable.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
    bucket.mockResolvedValue({ id: "images", name: "images", public: false });
    const denied = await app.handle(new Request(url));
    expect(denied.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { source.mockRestore(); bucket.mockRestore(); fetcher.mockRestore(); }
});
