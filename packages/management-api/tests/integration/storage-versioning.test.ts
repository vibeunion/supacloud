// @supacloud-test-isolate
import { afterEach, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { startStarterPostgres } from "../../../../scripts/lib/starter-postgres";
import * as projectDb from "../../src/db";
import { StorageRLS } from "../../src/services/storage-rls";
import { StorageService } from "../../src/services/storage.service";
import {
  cleanupProjectVersions,
  deleteExactVersion,
  ensureStorageVersioningSchema,
  getObjectVersion,
  getVersionDownloadResponse,
  setLifecycleConfiguration,
} from "../../src/services/storage-versioning";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
const bucketId = "versioned";
const objectName = "docs/report.txt";

function physicalKey(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

test.skipIf(!bin)("object versioning archives noncurrent bytes, creates delete markers and restores versions", async () => {
  const postgres = await startStarterPostgres(bin!);
  let database: SQL | undefined;
  const spies: Array<{ mockRestore(): void }> = [];
  const physical = new Map<string, Uint8Array>();

  try {
    database = await postgres.withConnection(async (connection) => {
      const url = new URL(connection);
      return new SQL({
        hostname: url.hostname,
        port: Number(url.port),
        database: "postgres",
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        max: 4,
      });
    });
    const db = database;
    await db.unsafe(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid AS $$ SELECT NULL::uuid $$ LANGUAGE SQL STABLE;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (
        id text PRIMARY KEY,
        name text NOT NULL,
        owner uuid,
        owner_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        public boolean NOT NULL DEFAULT false,
        avif_autodetection boolean NOT NULL DEFAULT false,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      CREATE TABLE storage.objects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id text REFERENCES storage.buckets(id),
        name text,
        owner uuid,
        owner_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_accessed_at timestamptz NOT NULL DEFAULT now(),
        metadata jsonb,
        user_metadata jsonb,
        path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
        version text DEFAULT gen_random_uuid()
      );
      CREATE UNIQUE INDEX objects_bucket_name_idx ON storage.objects (bucket_id, name);
      GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role;
    `);

    spies.push(spyOn(projectDb, "resolveDbName").mockResolvedValue("postgres"));
    spies.push(spyOn(projectDb, "getProjectDb").mockReturnValue(db));
    spies.push(spyOn(StorageRLS, "verifyToken").mockResolvedValue({
      role: "service_role",
      __allow_service_role: true,
    }));
    spies.push(spyOn(StorageService, "createBucket").mockResolvedValue({ success: true }));
    spies.push(spyOn(StorageService, "copyFile").mockImplementation(async (_ref, srcBucket, srcKey, destBucket, destKey) => {
      const bytes = physical.get(physicalKey(srcBucket, srcKey));
      if (!bytes) return false;
      physical.set(physicalKey(destBucket, destKey), new Uint8Array(bytes));
      return true;
    }));
    spies.push(spyOn(StorageService, "deleteFile").mockImplementation(async (_ref, bucket, key) => {
      return physical.delete(physicalKey(bucket, key));
    }));
    spies.push(spyOn(StorageService, "getDownloadResponse").mockImplementation(async (_ref, bucket, key) => {
      const bytes = physical.get(physicalKey(bucket, key));
      return bytes ? new Response(bytes) : null;
    }));

    await ensureStorageVersioningSchema("native-versioning");
    await db`
      INSERT INTO storage.buckets (id, name, public, versioning_status)
      VALUES (${bucketId}, ${bucketId}, false, 'ENABLED')
    `;

    const upload = async (content: string) => {
      const bytes = new TextEncoder().encode(content);
      const result = await StorageRLS.authorizeAction(
        "native-versioning",
        "fixture-token",
        "upload",
        bucketId,
        objectName,
        {
          mimetype: "text/plain",
          size: bytes.byteLength,
          cacheControl: "3600",
          eTag: `"${content}"`,
          userMetadata: { revision: content },
        },
        false,
        true,
        undefined,
        undefined,
        async () => {
          physical.set(physicalKey(bucketId, objectName), bytes);
        },
      );
      expect(result.permitted).toBe(true);
    };

    await upload("v1");
    const [first] = await db`
      SELECT version FROM storage.objects WHERE bucket_id = ${bucketId} AND name = ${objectName}
    `;
    const firstVersion = String(first.version);
    expect(firstVersion).toBeTruthy();
    expect(physical.get(physicalKey(bucketId, objectName))).toEqual(new TextEncoder().encode("v1"));

    await upload("v2");
    const archivedFirst = await getObjectVersion("native-versioning", bucketId, objectName, firstVersion);
    expect(archivedFirst?.metadata["size"]).toBe(2);
    const oldDownload = await getVersionDownloadResponse("native-versioning", bucketId, objectName, firstVersion);
    expect(oldDownload && await oldDownload.text()).toBe("v1");

    const deleteResult = await StorageRLS.authorizeAction(
      "native-versioning",
      "fixture-token",
      "delete",
      bucketId,
      objectName,
      {},
      false,
      true,
      undefined,
      undefined,
      async () => {
        physical.delete(physicalKey(bucketId, objectName));
      },
    );
    expect(deleteResult.permitted).toBe(true);
    const versions = await db`
      SELECT version_id, is_delete_marker FROM storage.object_versions
      WHERE bucket_id = ${bucketId} AND name = ${objectName}
      ORDER BY archived_at ASC
    `;
    expect(versions.map((row) => Boolean(row.is_delete_marker))).toEqual([false, false, true]);
    const marker = versions.find((row) => Boolean(row.is_delete_marker));
    expect(marker).toBeTruthy();

    expect(await deleteExactVersion("native-versioning", bucketId, objectName, String(marker.version_id))).toBe(true);
    const restored = await StorageRLS.getObjectInfo("native-versioning", bucketId, objectName, undefined, true);
    expect(restored?.version).toBeTruthy();
    expect(restored?.version).not.toBe(firstVersion);
    const restoredDownload = await StorageService.getDownloadResponse("native-versioning", bucketId, objectName);
    expect(restoredDownload && await restoredDownload.text()).toBe("v2");
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    try {
      await database?.close({ timeout: 1 });
    } finally {
      await postgres.close();
    }
  }
}, 60_000);

test.skipIf(!bin)("lifecycle expiration deletes old noncurrent versions and honors newerNoncurrentVersions", async () => {
  const postgres = await startStarterPostgres(bin!);
  let database: SQL | undefined;
  const spies: Array<{ mockRestore(): void }> = [];
  const deletedKeys: string[] = [];

  try {
    database = await postgres.withConnection(async (connection) => {
      const url = new URL(connection);
      return new SQL({
        hostname: url.hostname,
        port: Number(url.port),
        database: "postgres",
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        max: 4,
      });
    });
    const db = database;
    await db.unsafe(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid AS $$ SELECT NULL::uuid $$ LANGUAGE SQL STABLE;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (
        id text PRIMARY KEY,
        name text NOT NULL,
        owner uuid,
        owner_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        public boolean NOT NULL DEFAULT false,
        avif_autodetection boolean NOT NULL DEFAULT false,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      CREATE TABLE storage.objects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id text REFERENCES storage.buckets(id),
        name text,
        owner uuid,
        owner_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_accessed_at timestamptz NOT NULL DEFAULT now(),
        metadata jsonb,
        user_metadata jsonb,
        path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
        version text DEFAULT gen_random_uuid()
      );
      CREATE UNIQUE INDEX objects_bucket_name_idx ON storage.objects (bucket_id, name);
      GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role;
    `);

    spies.push(spyOn(projectDb, "resolveDbName").mockResolvedValue("postgres"));
    spies.push(spyOn(projectDb, "getProjectDb").mockReturnValue(db));
    spies.push(spyOn(StorageService, "deleteFile").mockImplementation(async (_ref, bucket, key) => {
      deletedKeys.push(`${bucket}/${key}`);
      return true;
    }));

    await ensureStorageVersioningSchema("native-lifecycle");
    await db`
      INSERT INTO storage.buckets (id, name, public, versioning_status)
      VALUES (${bucketId}, ${bucketId}, false, 'ENABLED')
    `;
    await setLifecycleConfiguration("native-lifecycle", bucketId, {
      rules: [{
        id: "expire-old",
        status: "Enabled",
        filter: {},
        noncurrentVersionExpiration: { noncurrentDays: 7, newerNoncurrentVersions: 1 },
      }],
    });
    for (const [index, ageDays] of [30, 20, 3].entries()) {
      await db`
        INSERT INTO storage.object_versions
          (bucket_id, name, version_id, metadata, is_delete_marker, created_at, archived_at)
        VALUES (
          ${bucketId}, ${objectName}, ${`version-${index}`},
          ${JSON.stringify({ size: index + 1 })}::jsonb, false,
          now() - (${ageDays} * interval '1 day'),
          now() - (${ageDays} * interval '1 day')
        )
      `;
    }

    const result = await cleanupProjectVersions("native-lifecycle");
    expect(result.versionsDeleted).toBe(1);
    const remaining = await db`
      SELECT version_id FROM storage.object_versions
      WHERE bucket_id = ${bucketId} AND name = ${objectName}
      ORDER BY archived_at DESC
    `;
    expect(remaining.map((row) => row.version_id)).toEqual(["version-2", "version-1"]);
    expect(deletedKeys).toContain(`.supacloud_versions/${bucketId}/${objectName}/version-0`);
    expect(deletedKeys).not.toContain(`.supacloud_versions/${bucketId}/${objectName}/version-2`);
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    try {
      await database?.close({ timeout: 1 });
    } finally {
      await postgres.close();
    }
  }
}, 60_000);