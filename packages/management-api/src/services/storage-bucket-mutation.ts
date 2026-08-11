import type { SQL } from "bun";
import {
  normalizedStorageFileSizeLimit,
  type StorageBucketSettings,
} from "./storage-bucket-contract";

type BucketRow = Record<string, unknown> & { revision: string };

type MutationFailure = {
  success: false;
  error: "Bucket not found" | "Bucket revision conflict" | "Bucket is not empty" | "Bucket deletion outcome is unknown";
};

export type BucketUpdateResult = MutationFailure | {
  success: true;
  bucket: BucketRow;
  previousRevision: string;
  newRevision: string;
};

export type BucketDeleteResult = MutationFailure | {
  success: true;
  previousRevision: string;
};

type BucketUpdateInput = {
  bucketId: string;
  expectedRevision: string;
  updates: StorageBucketSettings;
};

type BucketDeleteInput = {
  bucketId: string;
  expectedRevision: string;
  deletePhysicalBucket: () => Promise<{ success: boolean; error?: string }>;
};

async function lockedBucketRevision(database: SQL, bucketId: string): Promise<string | null> {
  const [bucket] = await database`
    SELECT FLOOR(EXTRACT(EPOCH FROM COALESCE(updated_at, created_at, TIMESTAMPTZ 'epoch')) * 1000000)::bigint::text AS revision
    FROM storage.buckets
    WHERE id = ${bucketId}
    FOR UPDATE
  ` as Array<{ revision: string }>;
  return bucket?.revision ?? null;
}

function revisionFailure(currentRevision: string | null, expectedRevision: string): MutationFailure | null {
  if (currentRevision === null) return { success: false, error: "Bucket not found" };
  return currentRevision === expectedRevision
    ? null
    : { success: false, error: "Bucket revision conflict" };
}

async function updateLockedBucket(database: SQL, input: BucketUpdateInput): Promise<BucketRow | null> {
  const mimeTypes = input.updates.allowed_mime_types?.length
    ? database.array(input.updates.allowed_mime_types, "TEXT")
    : null;
  const [bucket] = await database`
    UPDATE storage.buckets
    SET public = CASE WHEN ${input.updates.public !== undefined} THEN ${input.updates.public ?? false} ELSE public END,
        file_size_limit = CASE WHEN ${input.updates.file_size_limit !== undefined} THEN ${input.updates.file_size_limit ?? null} ELSE file_size_limit END,
        allowed_mime_types = CASE WHEN ${input.updates.allowed_mime_types !== undefined} THEN ${mimeTypes} ELSE allowed_mime_types END,
        updated_at = GREATEST(
          clock_timestamp(),
          COALESCE(updated_at, created_at, TIMESTAMPTZ 'epoch') + INTERVAL '1 microsecond'
        )
    WHERE id = ${input.bucketId}
      AND FLOOR(EXTRACT(EPOCH FROM COALESCE(updated_at, created_at, TIMESTAMPTZ 'epoch')) * 1000000)::bigint::text = ${input.expectedRevision}
    RETURNING id, name, public, created_at, updated_at, file_size_limit, allowed_mime_types,
      FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000000)::bigint::text AS revision
  ` as BucketRow[];
  return bucket
    ? { ...bucket, file_size_limit: normalizedStorageFileSizeLimit(bucket.file_size_limit) }
    : null;
}

export async function updateBucketAtRevision(database: SQL, input: BucketUpdateInput): Promise<BucketUpdateResult> {
  return database.begin(async (transaction) => {
    const currentRevision = await lockedBucketRevision(transaction, input.bucketId);
    const failure = revisionFailure(currentRevision, input.expectedRevision);
    if (failure) return failure;
    const bucket = await updateLockedBucket(transaction, input);
    if (!bucket) return { success: false, error: "Bucket revision conflict" };
    return {
      success: true,
      bucket,
      previousRevision: input.expectedRevision,
      newRevision: bucket.revision,
    };
  });
}

async function bucketContainsEntries(database: SQL, bucketId: string): Promise<boolean> {
  const [row] = await database`
    SELECT EXISTS(
      SELECT 1 FROM storage.objects WHERE bucket_id = ${bucketId}
    ) OR EXISTS(
      SELECT 1 FROM storage.s3_multipart_uploads WHERE bucket_id = ${bucketId}
    ) AS has_entries
  ` as Array<{ has_entries: boolean }>;
  return row?.has_entries === true;
}

async function deleteLockedBucket(database: SQL, input: BucketDeleteInput): Promise<boolean> {
  const deleted = await database`
    DELETE FROM storage.buckets
    WHERE id = ${input.bucketId}
      AND FLOOR(EXTRACT(EPOCH FROM COALESCE(updated_at, created_at, TIMESTAMPTZ 'epoch')) * 1000000)::bigint::text = ${input.expectedRevision}
    RETURNING id
  `;
  return deleted.length === 1;
}

function physicalDeletionFailure(deletion: { success: boolean; error?: string }): MutationFailure | null {
  if (deletion.success) return null;
  return {
    success: false,
    error: deletion.error === "Bucket is not empty"
      ? "Bucket is not empty"
      : "Bucket deletion outcome is unknown",
  };
}

export async function deleteEmptyBucketAtRevision(database: SQL, input: BucketDeleteInput): Promise<BucketDeleteResult> {
  return database.begin(async (transaction) => {
    const currentRevision = await lockedBucketRevision(transaction, input.bucketId);
    const failure = revisionFailure(currentRevision, input.expectedRevision);
    if (failure) return failure;
    if (await bucketContainsEntries(transaction, input.bucketId)) {
      return { success: false, error: "Bucket is not empty" };
    }
    const physicalFailure = physicalDeletionFailure(await input.deletePhysicalBucket());
    if (physicalFailure) return physicalFailure;
    if (!await deleteLockedBucket(transaction, input)) {
      return { success: false, error: "Bucket deletion outcome is unknown" };
    }
    return { success: true, previousRevision: input.expectedRevision };
  });
}
