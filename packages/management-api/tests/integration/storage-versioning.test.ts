// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
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
  purgeBucketVersions,
  setLifecycleConfiguration,
} from "../../src/services/storage-versioning";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
const bucketId = "versioned";
const objectName = "docs/report.txt";

function physicalKey(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

for (const versionType of ["text", "uuid"] as const) {
  test.skipIf(!bin)(`legacy Storage with ${versionType} versions upgrades before its first read and preserves existing objects`, async () => {
    const postgres = await startStarterPostgres(bin!);
    let database: SQL | undefined;
    const spies: Array<{ mockRestore(): void }> = [];
    const ref = `native-legacy-${versionType}`;
    const legacyVersion = crypto.randomUUID();
    const owner = crypto.randomUUID();
    const metadata = { size: 6, mimetype: "text/plain", cacheControl: "120", userMetadata: { legacy: true } };
    const physical = new Map([[physicalKey(bucketId, objectName), "legacy"]]);
    try {
      database = await postgres.withConnection((connection) => new SQL(connection));
      const db = database;
      await db.unsafe(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE ${versionType === "uuid" ? "legacy_placeholder" : "authenticated"} NOLOGIN;
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS uuid AS $$ SELECT NULL::uuid $$ LANGUAGE SQL STABLE;
        CREATE SCHEMA storage;
        CREATE TABLE storage.buckets (
          id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
          file_size_limit bigint, allowed_mime_types text[],
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE storage.objects (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
          name text NOT NULL, owner uuid, owner_id text, metadata jsonb, user_metadata jsonb,
          version ${versionType} DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(), last_accessed_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (bucket_id, name)
        );
        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
        CREATE POLICY legacy_read_policy ON storage.objects FOR SELECT USING (name LIKE 'docs/%');
        GRANT USAGE ON SCHEMA storage TO anon, service_role;
        GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role;
      `);
      await db`INSERT INTO storage.buckets (id, name) VALUES (${bucketId}, ${bucketId})`;
      await db`
        INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version)
        VALUES (${bucketId}, ${objectName}, ${owner}, ${owner}, ${metadata}, ${legacyVersion})
      `;
      const original = await db`SELECT * FROM storage.objects`;
      const policies = await db`SELECT policyname, qual FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage'`;
      spies.push(spyOn(projectDb, "resolveDbName").mockResolvedValue("postgres"));
      spies.push(spyOn(projectDb, "getProjectDb").mockReturnValue(db));
      spies.push(spyOn(StorageRLS, "verifyToken").mockResolvedValue({ role: "service_role", __allow_service_role: true }));
      const createBucket = spyOn(StorageService, "createBucket").mockResolvedValue({ success: true });
      spies.push(createBucket);
      const copy = spyOn(StorageService, "copyFile").mockImplementation(async (_ref, sourceBucket, source, targetBucket, target) => {
        const bytes = physical.get(physicalKey(sourceBucket, source));
        if (bytes === undefined) return false;
        physical.set(physicalKey(targetBucket, target), bytes);
        return true;
      });
      spies.push(copy);
      spies.push(spyOn(StorageService, "getDownloadResponse").mockImplementation(async (_ref, bucket, key) => {
        const bytes = physical.get(physicalKey(bucket, key));
        return bytes === undefined ? null : new Response(bytes);
      }));

      if (versionType === "uuid") {
        await expect(StorageRLS.listLogicalBucketsAsAdmin(ref)).rejects.toThrow('authenticated');
        const [partialMigration] = await db`
          SELECT to_regclass('storage.object_versions')::text AS history,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'versioning_status') AS has_status
        `;
        expect(partialMigration).toMatchObject({ history: null, has_status: false });
        await db.unsafe('CREATE ROLE authenticated NOLOGIN');
      }
      const buckets = versionType === "text"
        ? await StorageRLS.listLogicalBuckets(ref, "fixture-token")
        : await StorageRLS.listLogicalBucketsAsAdmin(ref);
      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.versioning_status).toBe("DISABLED");
      expect(await StorageRLS.listLogicalBuckets(ref, "fixture-token", { search: "version" })).toHaveLength(1);
      expect(await StorageRLS.getLogicalBucket(ref, bucketId, "fixture-token")).not.toBeNull();
      await ensureStorageVersioningSchema(ref);
      expect(Array.from(await db`SELECT * FROM storage.objects`)).toEqual(Array.from(original));
      expect(Array.from(await db`SELECT policyname, qual FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage'`)).toEqual(Array.from(policies));
      expect(createBucket).not.toHaveBeenCalled();
      expect(physical.get(physicalKey(bucketId, objectName))).toBe("legacy");

      await StorageRLS.registerLogicalBucket(ref, "fixture-token", bucketId, bucketId, false, undefined, undefined, "ENABLED");
      expect((await StorageRLS.getLogicalBucket(ref, bucketId, "fixture-token"))?.versioning_status).toBe("ENABLED");
      const preview = await StorageRLS.authorizeAction(ref, "fixture-token", "update", bucketId, objectName, metadata, true);
      expect(preview.permitted).toBe(true);
      expect(copy).not.toHaveBeenCalled();
      expect(createBucket).not.toHaveBeenCalled();

      const overwritten = await StorageRLS.authorizeAction(ref, "fixture-token", "update", bucketId, objectName, { ...metadata, size: 3 }, false, true, undefined, undefined, async () => {
        physical.set(physicalKey(bucketId, objectName), "new");
      });
      expect(overwritten.permitted).toBe(true);
      const archived = await getObjectVersion(ref, bucketId, objectName, legacyVersion);
      expect(archived?.metadata).toEqual(metadata);
      const [archivedOwner] = await db`SELECT owner_id FROM storage.object_versions WHERE version_id = ${legacyVersion}`;
      expect(archivedOwner?.owner_id).toBe(owner);
      const download = await getVersionDownloadResponse(ref, bucketId, objectName, legacyVersion);
      expect(download && await download.text()).toBe("legacy");
      expect(physical.get(physicalKey(bucketId, objectName))).toBe("new");
      await expect(StorageRLS.registerLogicalBucket(ref, "fixture-token", ".supacloud_versions", "reserved", false)).rejects.toThrow("reserved");
      await db`INSERT INTO storage.buckets (id, name) VALUES ('.supacloud_versions', 'legacy-customer-bucket')`;
      const rejected = await StorageRLS.authorizeAction(ref, "fixture-token", "update", bucketId, objectName, metadata, false, true, undefined, undefined, async () => {
        physical.set(physicalKey(bucketId, objectName), "must-not-write");
      });
      expect(rejected.permitted).toBe(false);
      expect(physical.get(physicalKey(bucketId, objectName))).toBe("new");
      const remove = spyOn(StorageService, "deleteFile").mockResolvedValue(false);
      spies.push(remove);
      expect(await deleteExactVersion(ref, bucketId, objectName, legacyVersion)).toBe(false);
      expect(await getObjectVersion(ref, bucketId, objectName, legacyVersion)).not.toBeNull();
      remove.mockImplementation(async (_ref, bucket, key) => physical.delete(physicalKey(bucket, key)));
      expect(await deleteExactVersion(ref, bucketId, objectName, legacyVersion)).toBe(true);
      expect(await getObjectVersion(ref, bucketId, objectName, legacyVersion)).toBeNull();
      expect(physical.get(physicalKey(bucketId, objectName))).toBe("new");
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
      try { await database?.close({ timeout: 1 }); }
      finally { await postgres.close(); }
    }
  }, 60_000);
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
    const exactCurrent = await getVersionDownloadResponse("native-versioning", bucketId, objectName, firstVersion);
    expect(exactCurrent && await exactCurrent.text()).toBe("v1");
    expect(await StorageRLS.authorizeObjectVersion("native-versioning", "fixture-token", "download", bucketId, objectName, firstVersion)).toBe(true);
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

    const deletedAgain = await StorageRLS.authorizeAction(
      "native-versioning", "fixture-token", "delete", bucketId, objectName, {}, false, true,
      undefined, undefined, async () => { physical.delete(physicalKey(bucketId, objectName)); },
    );
    expect(deletedAgain.permitted).toBe(true);
    const [oldMarker] = await db`
      SELECT version_id FROM storage.object_versions
      WHERE bucket_id = ${bucketId} AND name = ${objectName} AND is_delete_marker
      ORDER BY archived_at DESC LIMIT 1
    `;
    await upload("v3");
    expect(await deleteExactVersion("native-versioning", bucketId, objectName, String(oldMarker.version_id))).toBe(true);
    const newCurrent = await StorageService.getDownloadResponse("native-versioning", bucketId, objectName);
    expect(newCurrent && await newCurrent.text()).toBe("v3");
    await Promise.all([upload("v4"), upload("v5")]);
    const history = await db`SELECT version_id, metadata FROM storage.object_versions WHERE is_delete_marker = false`;
    const historyBytes: string[] = [];
    for (const version of history) {
      const bytes = await getVersionDownloadResponse("native-versioning", bucketId, objectName, String(version.version_id));
      expect(bytes).not.toBeNull();
      const text = await bytes!.text();
      expect(text).toBe((version.metadata as { userMetadata: { revision: string } }).userMetadata.revision);
      historyBytes.push(text);
    }
    const currentBytes = physical.get(physicalKey(bucketId, objectName));
    expect([...historyBytes, new TextDecoder().decode(currentBytes)]).toEqual(expect.arrayContaining(["v3", "v4", "v5"]));
    const mixedOptions = { includeCurrent: true, includeNoncurrent: true, includeMarkers: false, sortBy: { column: "created_at", order: "desc" } };
    const allEntries = await StorageRLS.listObjectVersions("native-versioning", "fixture-token", bucketId, mixedOptions);
    const firstPage = await StorageRLS.listObjectVersions("native-versioning", "fixture-token", bucketId, { ...mixedOptions, limit: 2 });
    const secondPage = await StorageRLS.listObjectVersions("native-versioning", "fixture-token", bucketId, { ...mixedOptions, limit: 2, offset: 2 });
    expect([...firstPage, ...secondPage].map((entry) => entry.version)).toEqual(allEntries.slice(0, 4).map((entry) => entry.version));
    expect(new Set(allEntries.map((entry) => entry.version)).size).toBe(allEntries.length);
    expect(allEntries.filter((entry) => entry.is_versioned === false)).toHaveLength(1);
    const archivedOnly = await StorageRLS.listObjectVersions("native-versioning", "fixture-token", bucketId, { ...mixedOptions, includeCurrent: false });
    expect(archivedOnly.every((entry) => entry.is_versioned === true)).toBe(true);

    const purged = await purgeBucketVersions("native-versioning", bucketId);
    expect(purged).toBeGreaterThan(0);
    expect(await db`SELECT id FROM storage.object_versions WHERE bucket_id = ${bucketId}`).toHaveLength(0);
    expect(physical.has(physicalKey(".supacloud_versions", `${bucketId}/${objectName}/${firstVersion}`))).toBe(false);
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
    expect(result.versionsDeleted).toBe(2);
    const remaining = await db`
      SELECT version_id FROM storage.object_versions
      WHERE bucket_id = ${bucketId} AND name = ${objectName}
      ORDER BY archived_at DESC
    `;
    expect(remaining.map((row) => row.version_id)).toEqual(["version-2"]);
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
