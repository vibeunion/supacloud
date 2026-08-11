import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  deleteEmptyBucketAtRevision,
  updateBucketAtRevision,
} from "../../src/services/storage-bucket-mutation";

const database = new SQL({
  url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
  max: 5,
});
const fixturePrefix = `storage-cas-${process.pid}-${Date.now()}`;

function fixtureBucket(suffix: string): string {
  return `${fixturePrefix}-${suffix}`;
}

async function installStorageFixture(): Promise<void> {
  await database`CREATE SCHEMA IF NOT EXISTS storage`;
  await database`
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      public boolean DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[]
    )
  `;
  await database`
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY,
      bucket_id text REFERENCES storage.buckets(id),
      name text
    )
  `;
  await database`
    CREATE TABLE IF NOT EXISTS storage.s3_multipart_uploads (
      id text PRIMARY KEY,
      in_progress_size bigint NOT NULL DEFAULT 0,
      upload_signature text NOT NULL,
      bucket_id text NOT NULL REFERENCES storage.buckets(id),
      key text NOT NULL,
      version text NOT NULL
    )
  `;
}

async function createBucket(bucketId: string): Promise<string> {
  const [bucket] = await database`
    INSERT INTO storage.buckets (id, name, public, created_at, updated_at)
    VALUES (${bucketId}, ${bucketId}, false, clock_timestamp(), clock_timestamp())
    RETURNING FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000000)::bigint::text AS revision
  ` as Array<{ revision: string }>;
  return bucket.revision;
}

async function bucketState(bucketId: string): Promise<Record<string, unknown> | null> {
  const [bucket] = await database`
    SELECT public, file_size_limit, allowed_mime_types,
      FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000000)::bigint::text AS revision
    FROM storage.buckets
    WHERE id = ${bucketId}
  `;
  return bucket ?? null;
}

async function deleteFixture(bucketId: string): Promise<void> {
  await database`DELETE FROM storage.objects WHERE bucket_id = ${bucketId}`;
  await database`DELETE FROM storage.s3_multipart_uploads WHERE bucket_id = ${bucketId}`;
  await database`DELETE FROM storage.buckets WHERE id = ${bucketId}`;
}

beforeAll(installStorageFixture);

afterAll(async () => {
  const fixturePattern = `${fixturePrefix}-%`;
  await database`
    DELETE FROM storage.objects
    WHERE bucket_id IN (SELECT id FROM storage.buckets WHERE id LIKE ${fixturePattern})
  `;
  await database`
    DELETE FROM storage.s3_multipart_uploads
    WHERE bucket_id IN (SELECT id FROM storage.buckets WHERE id LIKE ${fixturePattern})
  `;
  await database`DELETE FROM storage.buckets WHERE id LIKE ${fixturePattern}`;
  await database.close();
}, 30_000);

describe("Storage bucket revision CAS", () => {
  test("allows exactly one concurrent update at a shared revision", async () => {
    const bucketId = fixtureBucket("concurrent-update");
    const revision = await createBucket(bucketId);

    const mutations = await Promise.all([
      updateBucketAtRevision(database, { bucketId, expectedRevision: revision, updates: { public: true } }),
      updateBucketAtRevision(database, { bucketId, expectedRevision: revision, updates: { file_size_limit: 2048 } }),
    ]);
    const successes = mutations.filter((mutation) => mutation.success);
    const conflicts = mutations.filter((mutation) => !mutation.success);
    const stored = await bucketState(bucketId);

    expect(successes).toHaveLength(1);
    expect(conflicts).toEqual([{ success: false, error: "Bucket revision conflict" }]);
    expect(stored?.revision).not.toBe(revision);
    expect([
      { public: stored?.public, file_size_limit: Number(stored?.file_size_limit ?? 0) || null },
    ]).toEqual(
      stored?.public === true
        ? [{ public: true, file_size_limit: null }]
        : [{ public: false, file_size_limit: 2048 }],
    );
    await deleteFixture(bucketId);
  }, 30_000);

  test("rejects a stale list-to-write revision without changing the winner", async () => {
    const bucketId = fixtureBucket("list-write-race");
    const listedRevision = await createBucket(bucketId);
    const winner = await updateBucketAtRevision(database, {
      bucketId,
      expectedRevision: listedRevision,
      updates: { public: true },
    });
    const winnerState = await bucketState(bucketId);

    const staleMutation = await updateBucketAtRevision(database, {
      bucketId,
      expectedRevision: listedRevision,
      updates: { allowed_mime_types: ["application/pdf"] },
    });

    expect(winner.success).toBe(true);
    expect(staleMutation).toEqual({ success: false, error: "Bucket revision conflict" });
    expect(await bucketState(bucketId)).toEqual(winnerState);
    await deleteFixture(bucketId);
  }, 30_000);

  test("rejects a non-empty bucket before any physical or logical deletion", async () => {
    const bucketId = fixtureBucket("non-empty");
    const revision = await createBucket(bucketId);
    await database`
      INSERT INTO storage.objects (id, bucket_id, name)
      VALUES (${crypto.randomUUID()}, ${bucketId}, 'report.pdf')
    `;
    let physicalDeleteCount = 0;

    const deletion = await deleteEmptyBucketAtRevision(database, {
      bucketId,
      expectedRevision: revision,
      deletePhysicalBucket: async () => {
        physicalDeleteCount += 1;
        return { success: true };
      },
    });

    expect(deletion).toEqual({ success: false, error: "Bucket is not empty" });
    expect(physicalDeleteCount).toBe(0);
    expect(await bucketState(bucketId)).not.toBeNull();
    const [{ count }] = await database`SELECT count(*)::integer AS count FROM storage.objects WHERE bucket_id = ${bucketId}`;
    expect(count).toBe(1);
    await deleteFixture(bucketId);
  }, 30_000);

  test("rejects a stale delete revision with zero mutation", async () => {
    const bucketId = fixtureBucket("stale-delete");
    const revision = await createBucket(bucketId);
    let physicalDeleteCount = 0;

    const deletion = await deleteEmptyBucketAtRevision(database, {
      bucketId,
      expectedRevision: String(BigInt(revision) - 1n),
      deletePhysicalBucket: async () => {
        physicalDeleteCount += 1;
        return { success: true };
      },
    });

    expect(deletion).toEqual({ success: false, error: "Bucket revision conflict" });
    expect(physicalDeleteCount).toBe(0);
    expect(await bucketState(bucketId)).not.toBeNull();
    await deleteFixture(bucketId);
  }, 30_000);

  test("treats an active multipart upload as a non-empty bucket", async () => {
    const bucketId = fixtureBucket("multipart");
    const revision = await createBucket(bucketId);
    await database`
      INSERT INTO storage.s3_multipart_uploads
        (id, upload_signature, bucket_id, key, version)
      VALUES (${`${bucketId}-upload`}, 'signature', ${bucketId}, 'report.pdf', 'v1')
    `;
    let physicalDeleteCount = 0;

    const deletion = await deleteEmptyBucketAtRevision(database, {
      bucketId,
      expectedRevision: revision,
      deletePhysicalBucket: async () => {
        physicalDeleteCount += 1;
        return { success: true };
      },
    });

    expect(deletion).toEqual({ success: false, error: "Bucket is not empty" });
    expect(physicalDeleteCount).toBe(0);
    expect(await bucketState(bucketId)).not.toBeNull();
    await deleteFixture(bucketId);
  }, 30_000);

  test("holds the bucket row lock across empty validation and deletion", async () => {
    const bucketId = fixtureBucket("concurrent-object");
    const revision = await createBucket(bucketId);
    let objectInsertOutcome: Promise<{ success: boolean }> | undefined;

    const deletion = await deleteEmptyBucketAtRevision(database, {
      bucketId,
      expectedRevision: revision,
      deletePhysicalBucket: async () => {
        objectInsertOutcome = database`
          INSERT INTO storage.objects (id, bucket_id, name)
          VALUES (${crypto.randomUUID()}, ${bucketId}, 'late-object.pdf')
        `.then(
          () => ({ success: true }),
          () => ({ success: false }),
        );
        return { success: true };
      },
    });

    expect(deletion).toEqual({ success: true, previousRevision: revision });
    expect(await objectInsertOutcome).toEqual({ success: false });
    expect(await bucketState(bucketId)).toBeNull();
  }, 30_000);
});
