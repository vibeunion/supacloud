// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { startStarterPostgres } from "../../../../scripts/lib/starter-postgres";
import * as projectDb from "../../src/db";
import { StorageRLS } from "../../src/services/storage-rls";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;

test.skipIf(!bin)("logical bucket MIME arrays roundtrip through native PostgreSQL on create and upsert", async () => {
  const postgres = await startStarterPostgres(bin!);
  let database: SQL | undefined;
  const spies: Array<{ mockRestore(): void }> = [];
  try {
    database = await postgres.withConnection(async connection => {
      const url = new URL(connection);
      return new SQL({
        hostname: url.hostname, port: Number(url.port), database: "postgres",
        username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), max: 4,
      });
    });
    const db = database;
    await db.unsafe(`
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (
        id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL,
        file_size_limit bigint, allowed_mime_types text[],
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO service_role;
      GRANT SELECT, INSERT, UPDATE ON storage.buckets TO service_role;
    `);
    spies.push(spyOn(projectDb, "resolveDbName").mockResolvedValue("postgres"));
    spies.push(spyOn(projectDb, "getProjectDb").mockReturnValue(db));
    spies.push(spyOn(StorageRLS, "verifyToken").mockResolvedValue({
      role: "service_role", __allow_service_role: true,
    }));

    const cases: Array<{ name: string; input: string[] | null | undefined }> = [
      { name: "null", input: null },
      { name: "empty", input: [] },
      { name: "single", input: ["text/plain"] },
      { name: "multiple", input: ["text/plain", "application/json", "image/png"] },
      { name: "omitted", input: undefined },
    ];
    async function assertBucket(id: string, name: string, mimeTypes: string[] | null) {
      const rows = await db`
        SELECT name, public, file_size_limit::integer AS file_size_limit, allowed_mime_types,
          pg_typeof(allowed_mime_types)::text AS mime_type
        FROM storage.buckets WHERE id=${id}
      `;
      expect(Array.from(rows)).toEqual([{
        name, public: false, file_size_limit: 1024, allowed_mime_types: mimeTypes, mime_type: "text[]",
      }]);
    }
    for (const { name, input } of cases) {
      const expected = input?.length ? input : null;
      const id = `rls-${name}`;
      await StorageRLS.registerLogicalBucket("native", "fixture-token", id, name, false, 1024, input);
      await assertBucket(id, name, expected);

      // Reuse the same row to exercise ON CONFLICT, including clearing previous MIME restrictions.
      await StorageRLS.registerLogicalBucket("native", "fixture-token", "updated", name, false, 1024, input);
      await assertBucket("updated", name, expected);

      const bucket = { id: `admin-${name}`, name, public: false, fileSizeLimit: 1024, allowedMimeTypes: input };
      expect(await StorageRLS.createLogicalBucketAsAdmin("native", bucket)).toBe(true);
      await assertBucket(bucket.id, name, expected);
      expect(await StorageRLS.createLogicalBucketAsAdmin("native", {
        ...bucket, name: "must-not-overwrite", allowedMimeTypes: ["application/pdf"],
      })).toBe(false);
      await assertBucket(bucket.id, name, expected);
    }
    for (const input of [[], null]) {
      await StorageRLS.registerLogicalBucket("native", "fixture-token", "updated", "before-clear", false, 1024, ["text/plain"]);
      await StorageRLS.registerLogicalBucket("native", "fixture-token", "updated", "cleared", false, 1024, input);
      await assertBucket("updated", "cleared", null);
    }
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    try { await database?.close({ timeout: 1 }); }
    finally { await postgres.close(); }
  }
}, 60_000);
