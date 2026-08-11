import { afterAll, describe, expect, test } from "bun:test";
import { SQL, type ReservedSQL } from "bun";

interface StorageBucketMimeRow {
  allowed_mime_types: string[] | null;
}

const database = new SQL({
  url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
  max: 1,
});

async function withRollback(operation: (transaction: ReservedSQL) => Promise<void>): Promise<void> {
  const connection = await database.reserve();
  await connection.unsafe("BEGIN");
  try {
    await operation(connection);
  } finally {
    await connection.unsafe("ROLLBACK");
    connection.release();
  }
}

async function storedMimeTypes(
  transaction: ReservedSQL,
  fixtureId: string,
  mimeTypes: string[],
): Promise<string[] | null> {
  const mimeTypeBinding = mimeTypes.length > 0 ? transaction.array(mimeTypes, "TEXT") : null;
  const [bucket] = await transaction<StorageBucketMimeRow[]>`
    INSERT INTO storage_bucket_array_binding (fixture_id, allowed_mime_types)
    VALUES (${fixtureId}, ${mimeTypeBinding})
    ON CONFLICT (fixture_id) DO UPDATE
      SET allowed_mime_types = EXCLUDED.allowed_mime_types
    RETURNING allowed_mime_types
  `;
  return bucket.allowed_mime_types;
}

afterAll(async () => {
  await database.close();
}, 30_000);

describe("storage bucket TEXT[] binding", () => {
  test("round trips NULL clearing plus single and multiple MIME types", async () => {
    await withRollback(async (transaction) => {
      await transaction`
        CREATE TEMPORARY TABLE storage_bucket_array_binding (
          fixture_id TEXT PRIMARY KEY,
          allowed_mime_types TEXT[]
        ) ON COMMIT DROP
      `;

      expect(await storedMimeTypes(transaction, "reports", [])).toBeNull();
      expect(await storedMimeTypes(transaction, "reports", ["application/pdf"]))
        .toEqual(["application/pdf"]);
      expect(await storedMimeTypes(transaction, "reports", ["application/pdf", "image/png"]))
        .toEqual(["application/pdf", "image/png"]);
      expect(await storedMimeTypes(transaction, "reports", [])).toBeNull();
    });
  }, 30_000);
});
