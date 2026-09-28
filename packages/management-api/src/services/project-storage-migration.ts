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

/**
 * Read-only inventory of every object currently visible to the platform driver
 * for a project. The fingerprint is stable over keys and modification times, so
 * any write or delete between the plan and the bind changes it.
 */
export async function inventoryProjectObjects(ref: string, source: StorageDriver): Promise<ProjectStorageInventory> {
  const buckets = await source.listBuckets(ref);
  const entries: { bucket: string; key: string }[] = [];
  const parts: string[] = [];
  for (const bucket of buckets) {
    const files = await source.listFiles(ref, bucket.name);
    const sorted = [...files].sort((left, right) => left.name.localeCompare(right.name));
    for (const file of sorted) {
      entries.push({ bucket: bucket.name, key: file.name });
      parts.push(`${bucket.name}\u0000${file.name}\u0000${file.updated ?? ""}`);
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
    const uploaded = await target.uploadFile(ref, entry.bucket, entry.key, bytes, contentType);
    if (!uploaded) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    const readback = await target.getDownloadResponse(ref, entry.bucket, entry.key);
    if (!readback) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    const copy = new Uint8Array(await readback.arrayBuffer());
    if (copy.byteLength !== bytes.byteLength || await sha256Hex(copy) !== await sha256Hex(bytes)) {
      throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    }
  }
}