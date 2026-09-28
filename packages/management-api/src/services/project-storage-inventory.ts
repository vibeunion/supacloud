import type { SQL } from "bun";
import type { StorageDriver } from "./storage.adapter";
import { inventoryProjectObjects } from "./project-storage-migration";
import {
  PROJECT_STORAGE_ADOPTION_MAX_OBJECTS, ProjectStorageError, assertProjectRef,
} from "./project-storage-contract";

/**
 * Use the tenant's authoritative object catalogue for adoption. Legacy driver
 * listing methods are UI helpers: some truncate at one S3 page or hide errors
 * as empty lists, so they cannot establish migration completeness.
 */
export function createProjectStorageInventory(dependencies: {
  database: SQL;
  getProjectDb: (name: string) => SQL;
}) {
  return async (ref: string, source: StorageDriver) => {
    assertProjectRef(ref);
    try {
      const [project] = await dependencies.database`
        SELECT db_name FROM projects WHERE ref = ${ref} AND deleted_at IS NULL
          AND lower(status) IN ('active', 'creating')
      ` as Array<{ db_name: string }>;
      if (!project || typeof project.db_name !== "string" || !project.db_name) {
        throw new ProjectStorageError("STORAGE_CONFIG_INVALID", 400);
      }
      const [uploads] = await dependencies.database`
        SELECT EXISTS (SELECT 1 FROM system_tus_uploads WHERE ref = ${ref})
          OR EXISTS (SELECT 1 FROM system_signed_uploads WHERE ref = ${ref}) AS occupied
      ` as Array<{ occupied: boolean }>;
      const projectDb = dependencies.getProjectDb(project.db_name);
      const [multipart] = await projectDb`
        SELECT EXISTS (SELECT 1 FROM storage.s3_multipart_uploads) AS occupied
      ` as Array<{ occupied: boolean }>;
      if (!uploads || !multipart) throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
      if (uploads.occupied || multipart.occupied) {
        throw new ProjectStorageError("STORAGE_CONFIG_CONFLICT", 409);
      }
      const buckets = await projectDb`SELECT id FROM storage.buckets ORDER BY id` as Array<{ id: string }>;
      const objects = await projectDb`
        SELECT bucket_id, name FROM storage.objects ORDER BY bucket_id, name
        LIMIT ${PROJECT_STORAGE_ADOPTION_MAX_OBJECTS + 1}
      ` as Array<{ bucket_id: string; name: string }>;
      // Reject before downloading any body, not after an unbounded full scan.
      if (objects.length > PROJECT_STORAGE_ADOPTION_MAX_OBJECTS) {
        throw new ProjectStorageError("STORAGE_ADOPTION_LIMIT", 413);
      }
      const bucketIds = new Set(buckets.map((bucket) => bucket.id));
      if (objects.some((object) => !bucketIds.has(object.bucket_id))) {
        throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
      }
      return await inventoryProjectObjects(ref, source, {
        buckets: [...bucketIds],
        objects: objects.map((object) => ({ bucket: object.bucket_id, key: object.name })),
      });
    } catch (error) {
      if (error instanceof ProjectStorageError) throw error;
      // Database and source errors may contain credentials or internal paths.
      throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    }
  };
}
