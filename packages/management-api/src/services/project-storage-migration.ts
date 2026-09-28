import type { StorageDriver } from "./storage.adapter";
import {
  ProjectStorageError,
  type ProjectStorageInventory,
} from "./project-storage-contract";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A complete catalogue supplied by the project's authoritative metadata. */
export interface ProjectStorageManifest {
  buckets: string[];
  objects: { bucket: string; key: string }[];
}

/**
 * Hash all catalogue entries, including bytes and MIME metadata rather than
 * trusting timestamps. Production adoption supplies a tenant metadata manifest;
 * the driver-listing path is retained for standalone, complete test drivers.
 */
export async function inventoryProjectObjects(
  ref: string,
  source: StorageDriver,
  manifest?: ProjectStorageManifest,
): Promise<ProjectStorageInventory> {
  const buckets = manifest
    ? manifest.buckets.map((name) => ({ name }))
    : await source.listBuckets(ref);
  const entries: ProjectStorageInventory["entries"] = [];
  const parts: string[] = [];
  for (const bucket of buckets) {
    parts.push(JSON.stringify(["bucket", bucket.name]));
    const files = manifest
      ? manifest.objects.filter((object) => object.bucket === bucket.name).map((object) => ({ name: object.key }))
      : await source.listFiles(ref, bucket.name);
    const sorted = [...files].sort((left, right) => left.name.localeCompare(right.name));
    for (const file of sorted) {
      const response = await source.getDownloadResponse(ref, bucket.name, file.name);
      if (!response) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = await sha256Hex(bytes);
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      entries.push({ bucket: bucket.name, key: file.name, digest, contentType });
      parts.push(JSON.stringify(["object", bucket.name, file.name, digest, contentType]));
    }
  }
  parts.sort();
  return {
    buckets: buckets.length,
    objects: entries.length,
    fingerprint: await sha256Hex(new TextEncoder().encode(parts.join("\n"))),
    entries,
  };
}

/**
 * Copy every inventoried object to the project backend and verify it by
 * re-reading the copy. Idempotent: re-running overwrites and re-verifies.
 * Source objects are never deleted.
 */
export async function migrateProjectObjects(
  ref: string,
  source: StorageDriver,
  target: StorageDriver,
  inventory: ProjectStorageInventory,
): Promise<void> {
  for (const entry of inventory.entries) {
    const downloaded = await source.getDownloadResponse(ref, entry.bucket, entry.key);
    if (!downloaded) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    const contentType = downloaded.headers.get("content-type") ?? "application/octet-stream";
    if (await sha256Hex(bytes) !== entry.digest || contentType !== entry.contentType) {
      throw new ProjectStorageError("STORAGE_ADOPTION_SOURCE_CHANGED", 409);
    }
    const uploaded = await target.uploadFile(ref, entry.bucket, entry.key, bytes, contentType);
    if (!uploaded) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    const readback = await target.getDownloadResponse(ref, entry.bucket, entry.key);
    if (!readback) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    const copy = new Uint8Array(await readback.arrayBuffer());
    if (copy.byteLength !== bytes.byteLength
      || await sha256Hex(copy) !== entry.digest
      || (readback.headers.get("content-type") ?? "application/octet-stream") !== entry.contentType) {
      throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    }
  }
}
