import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  parseDeliveryBuildManifest, readDeliveryExecutableArchive, readDeliveryMigrationArchive, type DeliveryBuildManifest,
} from "@supacloud/delivery";
import { ApplicationReleaseError, type ApplicationReleaseStorage } from "./application-release-storage";

export const APPLICATION_RELEASE_UPLOAD_MAX_BYTES = 140 * 1024 * 1024;
const objectsSchema = Type.Record(
  Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
  Type.String({ pattern: "^[a-f0-9]{64}$" }),
  { additionalProperties: false },
);

function invalid(code = "APPLICATION_RELEASE_UPLOAD_INVALID", statusCode = 400): never {
  throw new ApplicationReleaseError(code, statusCode);
}

async function readUpload(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) invalid("APPLICATION_RELEASE_CONTENT_TYPE", 415);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^[1-9]\d*$/.test(declaredLength)
    || Number(declaredLength) > APPLICATION_RELEASE_UPLOAD_MAX_BYTES)) {
    invalid("APPLICATION_RELEASE_UPLOAD_TOO_LARGE", 413);
  }
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > APPLICATION_RELEASE_UPLOAD_MAX_BYTES) {
        await reader.cancel();
        invalid("APPLICATION_RELEASE_UPLOAD_TOO_LARGE", 413);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (signal.aborted) invalid("APPLICATION_RELEASE_UPLOAD_ABORTED", 408);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (declaredLength !== null && length !== Number(declaredLength)) invalid();
  try {
    return await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData();
  } catch { invalid(); }
}

export async function uploadApplicationRelease(
  request: Request, projectRef: string, applicationId: string,
  storage: Pick<ApplicationReleaseStorage, "importRelease">,
) {
  const form = await readUpload(request);
  const fields = [...form.entries()];
  if (new Set(fields.map(([name]) => name)).size !== fields.length) invalid();
  const manifestField = form.get("manifest");
  const objectsField = form.get("expected_objects");
  if (typeof manifestField !== "string" || Buffer.byteLength(manifestField) > 1_048_576
    || typeof objectsField !== "string" || Buffer.byteLength(objectsField) > 8192) invalid();
  let manifest: DeliveryBuildManifest, expectedObjects: unknown;
  try {
    manifest = parseDeliveryBuildManifest(JSON.parse(manifestField));
    expectedObjects = JSON.parse(objectsField);
  } catch { invalid(); }
  if (!Value.Check(objectsSchema, expectedObjects)) invalid();
  if (manifest.objects.length === 0 || manifest.objects.length > 32
    || manifest.objects.some(object => object.entryKind === "compiled-module-factory" || object.files.length > 1024)
    || manifest.objects.some(object => object.files.some(file => file.bytes > 64 * 1024 * 1024))
    || manifest.objects.reduce((total, object) =>
      total + object.files.reduce((sum, file) => sum + file.bytes, 0), 0) > 128 * 1024 * 1024) invalid();
  const inventory = manifest.objects.flatMap(object => object.files.map(file => ({
    path: `objects/${object.objectId}/${file.path}`, bytes: file.bytes,
  })));
  if (fields.length !== inventory.length + 2) invalid();
  for (const entry of inventory) {
    const file = form.get(entry.path);
    if (!(file instanceof File) || file.size !== entry.bytes) invalid();
  }
  const directory = await mkdtemp(join(tmpdir(), "supacloud-application-upload-"));
  try {
    const manifestPath = join(directory, "delivery.manifest.json");
    await writeFile(manifestPath, manifestField, { flag: "wx", mode: 0o600 });
    for (const entry of inventory) {
      const file = form.get(entry.path);
      if (!(file instanceof File)) invalid();
      const path = join(directory, entry.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: 0o600 });
    }
    try {
      await readDeliveryExecutableArchive(manifestPath);
      for (const object of manifest.objects) await readDeliveryMigrationArchive(manifestPath, object.name);
    } catch { invalid(); }
    return await storage.importRelease({ projectRef, applicationId, manifestPath, expectedObjects });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
