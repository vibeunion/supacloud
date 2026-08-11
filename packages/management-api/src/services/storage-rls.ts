import { getProjectDb, sql as metaSql, resolveDbName } from "../db";
import { logger } from "../utils/logger";
import { verifyProjectJwtPayload } from "../utils/project-jwt";
import { isOpaqueApiKey } from "../utils/api-keys";
import { resolveProjectApiKey } from "../utils/project-auth";


// ── TEST MOCK STATE ──
export const mockBuckets = new Map<string, any>();
export const mockObjects = new Map<string, any>();

type LogicalBucketInput = {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
};

function normalizeSqlRole(role: unknown, allowServiceRole = false): 'anon' | 'authenticated' | 'service_role' {
  if (allowServiceRole && role === 'service_role') return 'service_role';
  return role === 'authenticated' ? 'authenticated' : 'anon';
}

export function normalizeStorageObjectSize(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : fallback;

  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

async function applyRlsContext(tx: import("bun").SQL, payload: Record<string, unknown>): Promise<void> {
  const role = normalizeSqlRole(payload.role, payload.__allow_service_role === true);
  await tx.unsafe(`SET LOCAL ROLE "${role}"`);
  await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ ...payload, role })}, true)`;
  await tx`SELECT set_config('request.jwt.claim.sub', ${String(payload.sub || '')}, true)`;
  await tx`SELECT set_config('request.jwt.claim.role', ${role}, true)`;
}

async function upsertLogicalBucket(db: import("bun").SQL, bucket: LogicalBucketInput): Promise<void> {
  const allowedMimeTypes = bucket.allowedMimeTypes?.length ? bucket.allowedMimeTypes : null;
  await db`
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at)
    VALUES (${bucket.id}, ${bucket.name}, ${bucket.public}, ${bucket.fileSizeLimit || null}, ${allowedMimeTypes}, now(), now())
    ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, name = EXCLUDED.name, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types, updated_at = now()
  `;
}

export class StorageRLS {

  
  static async registerLogicalBucket(ref: string, token: string | undefined, bucketId: string, name: string, isPublic: boolean, fileSizeLimit?: number | null, allowedMimeTypes?: string[] | null): Promise<void> {
    if (ref === 'test_mock') {
      mockBuckets.set(bucketId, { id: bucketId, name, public: isPublic, file_size_limit: fileSizeLimit || null, allowed_mime_types: allowedMimeTypes || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return;
    }

    try {
        await this.withBucketRLS(ref, token, async (tx) => {
            await upsertLogicalBucket(tx, {
              id: bucketId,
              name,
              public: isPublic,
              fileSizeLimit,
              allowedMimeTypes,
            });
        });
    } catch (e: any) {
        throw new Error(e.message || "Failed to create bucket");
    }
  }

  static async createLogicalBucketAsAdmin(ref: string, bucket: LogicalBucketInput): Promise<boolean> {
    if (ref === 'test_mock') {
      if (mockBuckets.has(bucket.id)) return false;
      mockBuckets.set(bucket.id, {
        id: bucket.id,
        name: bucket.name,
        public: bucket.public,
        file_size_limit: bucket.fileSizeLimit || null,
        allowed_mime_types: bucket.allowedMimeTypes?.length ? bucket.allowedMimeTypes : null,
      });
      return true;
    }
    const dbName = await resolveDbName(ref);
    const db = getProjectDb(dbName);
    const rows = await db`
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at)
      VALUES (${bucket.id}, ${bucket.name}, ${bucket.public}, ${bucket.fileSizeLimit || null}, ${bucket.allowedMimeTypes?.length ? bucket.allowedMimeTypes : null}, now(), now())
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  }

  static async listLogicalBucketsAsAdmin(ref: string): Promise<Record<string, unknown>[]> {
    if (ref === 'test_mock') return Array.from(mockBuckets.values());
    const dbName = await resolveDbName(ref);
    const db = getProjectDb(dbName);
    return await db`
      SELECT id, name, public, created_at, updated_at, file_size_limit, allowed_mime_types
      FROM storage.buckets
      ORDER BY name ASC
    `;
  }

  static async deleteLogicalBucketAsAdmin(ref: string, bucketId: string): Promise<void> {
    if (ref === 'test_mock') {
      if (Array.from(mockObjects.keys()).some((key) => key.startsWith(`${bucketId}/`))) {
        throw new Error("Bucket is not empty");
      }
      mockBuckets.delete(bucketId);
      return;
    }
    const dbName = await resolveDbName(ref);
    const db = getProjectDb(dbName);
    const deleted = await db`
      DELETE FROM storage.buckets
      WHERE id = ${bucketId}
        AND NOT EXISTS (
          SELECT 1 FROM storage.objects WHERE bucket_id = ${bucketId}
        )
      RETURNING id
    `;
    if (deleted.length > 0) return;

    const [bucket] = await db`SELECT id FROM storage.buckets WHERE id = ${bucketId}`;
    if (bucket) throw new Error("Bucket is not empty");
  }

  
  static async listLogicalBuckets(
    ref: string, 
    token: string | undefined,
    options?: { limit?: number; offset?: number; search?: string, sortBy?: { column?: string; order?: string } }
  ): Promise<Record<string, unknown>[]> {
    if (ref === 'test_mock') return Array.from(mockBuckets.values());

    return await this.withBucketRLS(ref, token, async (tx) => {
        let query = tx`SELECT id, name, public, created_at, updated_at, file_size_limit, allowed_mime_types FROM storage.buckets`;
        if (options?.search) {
             const searchTerm = `%${options.search}%`;
             query = tx`${query} WHERE name ILIKE ${searchTerm}`;
        }
        const col = options?.sortBy?.column || 'name';
        const ord = (options?.sortBy?.order || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        
        if (col === 'updated_at') {
            query = ord === 'DESC' ? tx`${query} ORDER BY updated_at DESC` : tx`${query} ORDER BY updated_at ASC`;
        } else if (col === 'created_at') {
            query = ord === 'DESC' ? tx`${query} ORDER BY created_at DESC` : tx`${query} ORDER BY created_at ASC`;
        } else if (col === 'id') {
            query = ord === 'DESC' ? tx`${query} ORDER BY id DESC` : tx`${query} ORDER BY id ASC`;
        } else {
            query = ord === 'DESC' ? tx`${query} ORDER BY name DESC` : tx`${query} ORDER BY name ASC`;
        }
        if (options?.limit) {
            query = tx`${query} LIMIT ${options.limit}`;
        }
        if (options?.offset) {
            query = tx`${query} OFFSET ${options.offset}`;
        }
        return await query;
    });
  }

  static async rollbackLogicalBucket(ref: string, bucketId: string): Promise<void> {
    if (ref === 'test_mock') {
        mockBuckets.delete(bucketId);
        return;
    }
    const dbName = await resolveDbName(ref);
    const db = getProjectDb(dbName);
    await db`DELETE FROM storage.buckets WHERE id = ${bucketId}`.catch(() => {});
  }

  
  static async getLogicalBucket(ref: string, bucketId: string, token: string | undefined, adminOverride = false): Promise<Record<string, unknown> | null> {
    if (ref === 'test_mock') return mockBuckets.get(bucketId) || null;

    if (adminOverride) {
        const dbName = await resolveDbName(ref);
        const db = getProjectDb(dbName);
        const rows = await db`SELECT id, name, public, created_at, updated_at, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = ${bucketId}`;
        return (rows[0] as Record<string, unknown>) || null;
    }

    return await this.withBucketRLS(ref, token, async (tx) => {
        const rows = await tx`SELECT id, name, public, created_at, updated_at, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = ${bucketId}`;
        return (rows[0] as Record<string, unknown>) || null;
    }).catch(() => null);
  }

  static async objectExists(ref: string, bucketId: string, objectName: string, token: string | undefined): Promise<boolean> {
    if (ref === 'test_mock') return mockObjects.has(bucketId + '/' + objectName);

    return await this.withBucketRLS(ref, token, async (tx) => {
      const rows = await tx`
        SELECT 1
        FROM storage.objects
        WHERE bucket_id = ${bucketId} AND name = ${objectName}
        LIMIT 1
      `;
      return rows.length > 0;
    }).catch(() => false);
  }

  static async getObjectInfo(ref: string, bucketId: string, objectName: string, token: string | undefined, adminOverride = false): Promise<Record<string, unknown> | null> {
    if (ref === 'test_mock') {
      const obj = mockObjects.get(bucketId + '/' + objectName);
      if (!obj) return null;
      const size = normalizeStorageObjectSize(obj.metadata?.size);
      return {
        id: bucketId + '/' + objectName,
        name: objectName,
        bucket_id: bucketId,
        size,
        cache_control: 'no-cache',
        content_type: obj.metadata?.mimetype || 'application/octet-stream',
        created_at: obj.updated || new Date().toISOString(),
        updated_at: obj.updated || new Date().toISOString(),
        last_modified: obj.updated || new Date().toISOString(),
        etag: 'mock-etag-' + Date.now(),
        version: 'v1-' + Date.now(),
        metadata: obj.metadata?.userMetadata || {},
      };
    }

    if (adminOverride) {
        const dbName = await resolveDbName(ref);
        const db = getProjectDb(dbName);
        const rows = await db`
         
          SELECT id, name, bucket_id, owner, metadata, created_at, updated_at, last_accessed_at, version
          FROM storage.objects
          WHERE bucket_id = ${bucketId} AND name = ${objectName}
          LIMIT 1
        `;
        if (rows.length === 0) return null;
        const row = rows[0] as Record<string, unknown>;
        const meta = (row.metadata || {}) as Record<string, unknown>;
        const size = normalizeStorageObjectSize(meta.size);
        return {
          id: row.id ? String(row.id) : null,
          name: String(row.name),
          bucket_id: String(row.bucket_id),
          owner: row.owner ? String(row.owner) : undefined,
          size,
          cache_control: String(meta.cacheControl || meta.cache_control || '3600').replace(/^max-age=/, ''),
          content_type: String(meta.mimetype || 'application/octet-stream'),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
          last_modified: String(row.updated_at),
          version: row.version ? String(row.version) : String(row.id || crypto.randomUUID()),
          etag: (meta.eTag || meta.etag || `"${row.id}"`) as string,
          last_accessed_at: String(row.last_accessed_at || row.updated_at),
          metadata: {
            eTag: String(meta.eTag || meta.etag || `"${row.id}"`),
            size,
            mimetype: String(meta.mimetype || 'application/octet-stream'),
            cacheControl: String(meta.cacheControl || meta.cache_control || '3600').replace(/^max-age=/, ''),
            lastModified: String(row.updated_at),
            contentLength: size,
            httpStatusCode: 200,
            ...(meta.userMetadata && typeof meta.userMetadata === 'object' ? meta.userMetadata as Record<string, unknown> : {})
          }
        };
    }

    return await this.withBucketRLS(ref, token, async (tx) => {
      const rows = await tx`
        SELECT id, name, bucket_id, metadata, created_at, updated_at, version
        FROM storage.objects
        WHERE bucket_id = ${bucketId} AND name = ${objectName}
        LIMIT 1
      `;
      if (rows.length === 0) return null;

      const row = rows[0] as Record<string, unknown>;
      const meta = (row.metadata || {}) as Record<string, unknown>;
      const size = normalizeStorageObjectSize(meta.size);
      return {
        id: row.id ? String(row.id) : null,
        name: String(row.name),
        bucket_id: String(row.bucket_id),
        owner: row.owner ? String(row.owner) : undefined,
        size,
        cache_control: String(meta.cacheControl || meta.cache_control || '3600').replace(/^max-age=/, ''),
        content_type: String(meta.mimetype || 'application/octet-stream'),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        last_modified: String(row.updated_at),
        version: row.version ? String(row.version) : String(row.id || crypto.randomUUID()),
        etag: (meta.eTag || meta.etag || `"${row.id}"`) as string,
        last_accessed_at: String(row.last_accessed_at || row.updated_at),
        metadata: {
            eTag: String(meta.eTag || meta.etag || `"${row.id}"`),
            size,
            mimetype: String(meta.mimetype || 'application/octet-stream'),
            cacheControl: String(meta.cacheControl || meta.cache_control || '3600').replace(/^max-age=/, ''),
            lastModified: String(row.updated_at),
            contentLength: size,
            httpStatusCode: 200,
            ...(meta.userMetadata && typeof meta.userMetadata === 'object' ? meta.userMetadata as Record<string, unknown> : {})
        }
      };
    }).catch(() => null);
  }

  static async getTenantJwtSecret(ref: string): Promise<string | null> {
    const rows = await metaSql`SELECT jwt_secret FROM projects WHERE ref=${ref}`;
    return rows[0]?.jwt_secret || null;
  }

  static async verifyToken(ref: string, token: string) {
    let cleanToken = token.replace(/^Bearer\s+/i, '');
    if (isOpaqueApiKey(cleanToken)) {
      const apiKey = await resolveProjectApiKey(cleanToken, { includeProvisioning: true });
      if (!apiKey || apiKey.ref !== ref) throw new Error("tenant not found");
      cleanToken = apiKey.upstreamKey;
    }
    const verification = await verifyProjectJwtPayload(ref, cleanToken, { includeProvisioning: true });
    if (!verification) throw new Error("tenant not found");
    return {
      ...verification.payload,
      __allow_service_role: verification.isServiceRole,
    };
  }

  
  
  static async withBucketRLS<T>(
    ref: string,
    token: string | null | undefined,
    callback: (tx: import("bun").SQL, payload: Record<string, unknown>) => Promise<T>
  ): Promise<T> {
    const dbName = await resolveDbName(ref);
    const db = getProjectDb(dbName);
    
    let payload: Record<string, unknown> = { role: 'anon' };
    if (token) {
      try {
        payload = await this.verifyToken(ref, token);
      } catch (e) {
        throw new Error('Access Denied');
      }
    }

    return await db.begin(async (tx: import("bun").SQL) => {
        await applyRlsContext(tx, payload);
        return await callback(tx, { ...payload, role: normalizeSqlRole(payload.role, payload.__allow_service_role === true) });
    });
  }

  static async authorizeAction(
    ref: string,
    token: string | null | undefined,
    action: 'upload' | 'download' | 'delete' | 'update' | 'move',
    bucketId: string,
    objectName: string,
    metadata: Record<string, unknown> = {},
    dryRun: boolean = false,
    upsert: boolean = true,
    destBucketId?: string,
    destObjectName?: string,
    physicalAction?: () => Promise<void>,
    compensatePhysicalAction?: () => Promise<void>
  ): Promise<{ permitted: boolean, error?: string }> {
    let physicalActionCompleted = false;
    if (ref === 'test_mock') {
       if (!mockBuckets.has(bucketId)) return { permitted: false, error: 'Bucket not found' };
       if (action === 'upload') {
           if (!upsert && mockObjects.has(bucketId + '/' + objectName)) {
               return { permitted: false, error: 'The resource already exists' };
           }
           if (physicalAction) {
               try {
                   await physicalAction();
                   physicalActionCompleted = true;
               } catch (e: any) {
                   return { permitted: false, error: e.message === 'PHYSICAL_UPLOAD_FAILED' ? 'Failed to write physical object' : e.message };
               }
           }
           if (!dryRun) mockObjects.set(bucketId + '/' + objectName, { metadata, updated: new Date().toISOString() });
       }
       if (action === 'download' || action === 'delete') {
           if (!mockObjects.has(bucketId + '/' + objectName)) return { permitted: false, error: 'Object not found' };
           if (action === 'delete') {
               if (physicalAction) {
                   try { await physicalAction(); } catch (e) {}
               }
               mockObjects.delete(bucketId + '/' + objectName);
           }
       }
       return { permitted: true };
    }

    const dbName = await resolveDbName(ref);
    const db = getProjectDb(dbName);

    let payload: Record<string, unknown> = { role: 'anon' };
    if (token) {
      try {
        payload = await this.verifyToken(ref, token);
      } catch (e) {
        return { permitted: false, error: 'Row Level Security violation or bucket missing. Access Denied.' }; // Auth token invalid
      }
    }

    try {
      // Use a transaction so we respect standard RLS contexts
      await db.begin(async (tx) => {
        await applyRlsContext(tx, payload);

        // Prepare owner uuid safely (sometimes sub is not uuid)
        const owner = typeof payload.sub === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub) ? payload.sub : null;

        if (action === 'upload') {
          if (upsert) {
            const res = await tx`
              INSERT INTO storage.objects (bucket_id, name, owner, metadata)
              VALUES (${bucketId}, ${objectName}, ${owner}, ${ { ...metadata, userMetadata: metadata.userMetadata || {} } })
              ON CONFLICT (bucket_id, name)
              DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = now(), version = gen_random_uuid()
              RETURNING id
            `;
            if (res.length === 0) throw new Error("RLS_VIOLATION");
          } else {
            const res = await tx`
              INSERT INTO storage.objects (bucket_id, name, owner, metadata)
              VALUES (${bucketId}, ${objectName}, ${owner}, ${ { ...metadata, userMetadata: metadata.userMetadata || {} } })
              RETURNING id
            `;
            if (res.length === 0) throw new Error("RLS_VIOLATION");
          }
          
        } else if (action === 'download') {
          // Check if user is allowed to SELECT
          const res = await tx`
            SELECT id FROM storage.objects 
            WHERE bucket_id = ${bucketId} AND name = ${objectName} 
            LIMIT 1
          `;
          if (res.length === 0) throw new Error("RLS_VIOLATION_OR_NOT_FOUND");
          
        } else if (action === 'update') {
          const resSel = await tx`SELECT id FROM storage.objects WHERE bucket_id = ${bucketId} AND name = ${objectName} LIMIT 1`;
          if (resSel.length === 0) throw new Error("RLS_VIOLATION_OR_NOT_FOUND");
          const resUpd = await tx`
            UPDATE storage.objects 
            SET metadata = ${ { ...metadata, userMetadata: metadata.userMetadata || {} } }, updated_at = now(), version = gen_random_uuid()
            WHERE bucket_id = ${bucketId} AND name = ${objectName} 
            RETURNING id
          `;
          if (resUpd.length === 0) throw new Error("RLS_VIOLATION");
        } else if (action === 'move') {
          const resSel = await tx`SELECT id FROM storage.objects WHERE bucket_id = ${bucketId} AND name = ${objectName} LIMIT 1`;
          if (resSel.length === 0) throw new Error("RLS_VIOLATION_OR_NOT_FOUND");
          
          const resUpd = await tx`
            UPDATE storage.objects 
            SET name = ${destObjectName!}, bucket_id = ${destBucketId!}, updated_at = now(), version = gen_random_uuid()
            WHERE bucket_id = ${bucketId} AND name = ${objectName} 
            RETURNING id
          `;
          if (resUpd.length === 0) throw new Error("RLS_VIOLATION");
        } else if (action === 'delete') {
          const resSel = await tx`SELECT id FROM storage.objects WHERE bucket_id = ${bucketId} AND name = ${objectName} LIMIT 1`;
          if (resSel.length === 0) throw new Error("RLS_VIOLATION_OR_NOT_FOUND");
          const res = await tx`
            DELETE FROM storage.objects 
            WHERE bucket_id = ${bucketId} AND name = ${objectName} 
            RETURNING id
          `;
          if (res.length === 0) throw new Error("RLS_VIOLATION_OR_NOT_FOUND");
        }

        if (dryRun) {
          throw new Error("DRY_RUN_ROLLBACK");
        }

        if (physicalAction) {
          try {
            await physicalAction();
            physicalActionCompleted = true;
          } catch (e: any) {
            throw new Error(e.message === 'PHYSICAL_UPLOAD_FAILED' ? 'PHYSICAL_UPLOAD_FAILED' : 'PHYSICAL_ACTION_FAILED');
          }
        }
      });

      return { permitted: true };
    } catch (e: unknown) {
      if (physicalActionCompleted && compensatePhysicalAction) {
        try {
          await compensatePhysicalAction();
        } catch (compensationError) {
          logger.warn("[StorageRLS] Physical compensation failed after metadata transaction failure", {
            action,
            bucketId,
            objectName,
            error: compensationError instanceof Error ? compensationError.message : String(compensationError),
          });
        }
      }
      if (e instanceof Error && e.message === 'DRY_RUN_ROLLBACK') {
        return { permitted: true };
      }
      if (e instanceof Error && e.message === 'PHYSICAL_UPLOAD_FAILED') {
        return { permitted: false, error: 'Failed to write physical object' };
      }
      if ((e as any).code === '23505') {
        return { permitted: false, error: 'The resource already exists' };
      }
      // If error is RLS related (row level security policy violation) or Postgres throws, deny
      logger.debug(`[StorageRLS] Action ${action} denied: ${e instanceof Error ? e.message : String(e)}`);
      
      if (e instanceof Error && e.message === 'RLS_VIOLATION_OR_NOT_FOUND') {
          // P0-4: If bucket is public, we distinguish 404 vs 403. 
          try {
              const [{ is_public }] = await db`SELECT public AS is_public FROM storage.buckets WHERE id = ${bucketId}`;
              if (is_public) {
                  // Public bucket: If object exists -> 403. If not -> 404.
                  const resRaw = await db`SELECT id FROM storage.objects WHERE bucket_id = ${bucketId} AND name = ${objectName} LIMIT 1`;
                  if (resRaw.length > 0) return { permitted: false, error: 'Forbidden' };
              }
          } catch(e2) {}
          return { permitted: false, error: 'Object not found' };
      }
      return { permitted: false, error: 'Row Level Security violation or bucket missing. Access Denied.' };
    }
  }

  
  static async listObjects(
    ref: string,
    token: string | null | undefined,
    bucketId: string,
    prefix: string = '',
    limit: number = 100,
    offset: number = 0,
    sortBy?: { column?: string; order?: string },
    search: string = '',
    with_delimiter: boolean = true
  ): Promise<any[]> {
    if (ref === 'test_mock') {
      const folders = new Set<string>();
      const uniqueObjects: any[] = [];
      const searchLower = search.toLowerCase();
      
      for (const [key, val] of mockObjects.entries()) {
         if (key.startsWith(bucketId + '/' + prefix)) {
            const rawName = key.substring(bucketId.length + 1);
            if (search && !rawName.toLowerCase().includes(searchLower)) continue;

            const nameWithoutPrefix = rawName.slice(prefix.length).replace(/^\/+/, '');
            if (!nameWithoutPrefix) continue;

            const firstSlash = nameWithoutPrefix.indexOf('/');
            if (with_delimiter && firstSlash !== -1) {
                const folderName = nameWithoutPrefix.substring(0, firstSlash);
                if (!folders.has(folderName)) {
                    folders.add(folderName);
                    uniqueObjects.push({ 
                        id: null, 
                        name: prefix ? `${prefix.replace(/\/$/, '')}/${folderName}` : folderName, 
                        updated_at: val.updated, 
                        created_at: val.updated,
                        last_accessed_at: val.updated,
                        size: 0, 
                        type: null,
                        isFolder: true,
                        sortKey: folderName
                    });
                }
            } else {
                const size = normalizeStorageObjectSize(val.metadata?.size);
                const mimetype = val.metadata?.mimetype || (rawName.includes('.') ? rawName.split('.').pop() : 'unknown');
                uniqueObjects.push({ 
                    id: key, 
                    name: rawName, 
                    updated_at: val.updated, 
                    created_at: val.updated,
                    last_accessed_at: val.updated,
                    size,
                    type: mimetype,
                    metadata: {
                        size,
                        mimetype,
                        cacheControl: String(val.metadata?.cacheControl || val.metadata?.cache_control || '3600').replace(/^max-age=/, '')
                    },
                    isFolder: false,
                    sortKey: nameWithoutPrefix
                });
            }
         }
      }

      const sorted = uniqueObjects.sort((a, b) => {
        const column = sortBy?.column || 'name';
        const order = (sortBy?.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;

        if (column === 'updated_at' || column === 'updated') {
          return (new Date(a.updated_at || a.updated).getTime() - new Date(b.updated_at || b.updated).getTime()) * order;
        }
        if (column === 'created_at' || column === 'created') {
          return (new Date(a.created_at || a.updated_at || a.updated).getTime() - new Date(b.created_at || b.updated_at || b.updated).getTime()) * order;
        }
        if (column === 'metadata.size' || column === 'size') {
          return (a.size - b.size) * order;
        }
        return a.sortKey.localeCompare(b.sortKey) * order;
      });

      return sorted.slice(offset, offset + limit);
    }

    const dbName = await resolveDbName(ref);
    const db = getProjectDb(dbName);

    let payload: Record<string, unknown> = { role: 'anon' };
    if (token) {
      try {
        payload = await this.verifyToken(ref, token);
      } catch (e) {
        throw new Error('Access Denied');
      }
    }

    try {
      let results: any[] = [];
      await db.begin(async (tx) => {
        await applyRlsContext(tx, payload);

        const searchPrefix = prefix + '%';
        const searchTerm = `%${search}%`;
        const orderColumn = sortBy?.column === 'updated_at'
          ? 'updated_at'
          : sortBy?.column === 'created_at'
            ? 'created_at'
            : sortBy?.column === 'metadata.size'
              ? 'size'
              : 'name';
        const orderDirection = (sortBy?.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        const orderTarget = orderColumn === 'name' ? 'sort_key' : orderColumn;
        const orderClause = `${orderTarget} ${orderDirection}${orderTarget === 'sort_key' ? '' : ', sort_key ASC'}`;

        const [bucket] = await tx`SELECT id FROM storage.buckets WHERE id = ${bucketId}`;
        if (!bucket) throw new Error('BUCKET_NOT_FOUND');

        results = await tx.unsafe(`
          WITH candidates AS (
            SELECT
              id,
              name,
              updated_at,
              created_at,
              last_accessed_at,
              owner,
              metadata,
              CASE
                WHEN metadata->>'size' ~ '^[0-9]+$' THEN (metadata->>'size')::bigint
                ELSE 0
              END AS size,
              regexp_replace(substr(name, $5::int), '^/+', '') AS relative_name
            FROM storage.objects
            WHERE bucket_id = $1
              AND name LIKE $2
              AND ($3::boolean OR name ILIKE $4)
          ),
          normalized AS (
            SELECT
              *,
              CASE
                WHEN $9::boolean AND position('/' in relative_name) > 0
                  THEN split_part(relative_name, '/', 1)
                ELSE NULL
              END AS folder_name
            FROM candidates
            WHERE relative_name <> ''
          ),
          folders AS (
            SELECT
              NULL::uuid AS id,
              ($6::text || folder_name) AS name,
              max(updated_at) AS updated_at,
              min(created_at) AS created_at,
              max(last_accessed_at) AS last_accessed_at,
              NULL::uuid AS owner,
              jsonb_build_object('mimetype', NULL) AS metadata,
              0::bigint AS size,
              TRUE AS is_folder,
              folder_name AS sort_key
            FROM normalized
            WHERE folder_name IS NOT NULL
            GROUP BY folder_name
          ),
          files AS (
            SELECT
              id,
              name,
              updated_at,
              created_at,
              last_accessed_at,
              owner,
              metadata,
              size,
              FALSE AS is_folder,
              relative_name AS sort_key
            FROM normalized
            WHERE folder_name IS NULL
          )
          SELECT *
          FROM (
            SELECT * FROM folders
            UNION ALL
            SELECT * FROM files
          ) listed_objects
          ORDER BY ${orderClause}
          LIMIT $7 OFFSET $8
        `, [
          bucketId,
          searchPrefix,
          search === '',
          searchTerm,
          prefix.length + 1,
          prefix ? `${prefix.replace(/\/$/, '')}/` : '',
          limit,
          offset,
          with_delimiter,
        ]);
      });

      return results.map(row => {
          const meta = row.metadata || {};
          const size = normalizeStorageObjectSize(row.size ?? meta.size);
          return {
              name: row.name,
              id: row.id ? String(row.id) : null,
              updated_at: row.updated_at || row.updated,
              created_at: row.created_at || row.created || row.updated,
              last_accessed_at: row.last_accessed_at || row.last_accessed || row.updated,
              bucket_id: bucketId,
              owner: row.owner ? String(row.owner) : undefined,
              size,
              metadata: row.is_folder || row.isFolder ? null : {
                  size,
                  mimetype: String(meta.mimetype || 'application/octet-stream'),
                  cacheControl: String(meta.cacheControl || meta.cache_control || '3600').replace(/^max-age=/, '')
              }
          };
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[StorageRLS] List access denied:`, { error: msg });
      // Preserve specific errors so the route handler can map them correctly
      if (msg === 'BUCKET_NOT_FOUND' || msg === 'Access Denied' || msg === 'PROJECT_NOT_FOUND') {
        throw e;
      }
      throw new Error("RLS_VIOLATION_OR_NOT_FOUND");
    }
  }

  static async deleteLogicalBucket(ref: string, token: string | undefined, bucketId: string, dryRun: boolean = false): Promise<void> {
    if (ref === 'test_mock') {
        if (dryRun) return;
        if (Array.from(mockObjects.keys()).some(k => k.startsWith(`${bucketId}/`))) {
             throw new Error("Bucket is not empty");
        }
        mockBuckets.delete(bucketId);
        return;
    }
    
    try {
        await this.withBucketRLS(ref, token, async (tx) => {
            const resBuckets = await tx`DELETE FROM storage.buckets WHERE id = ${bucketId} RETURNING id`;
            if (resBuckets.length === 0) throw new Error("RLS_VIOLATION");
            if (dryRun) throw new Error("DRY_RUN_ROLLBACK");
        });
    } catch (e: any) {
        if (e.message === 'DRY_RUN_ROLLBACK') return;
        // Map native Postgres FK constraint error for non-empty folders
        if (e.code === '23503') throw new Error("Bucket is not empty");
        throw new Error(e.message === 'RLS_VIOLATION' ? "You do not have permission to delete this bucket" : (e.message || "Failed to delete bucket"));
    }
  }

  static async emptyLogicalBucket(ref: string, token: string | undefined, bucketId: string, dryRun: boolean = false): Promise<void> {
    if (ref === 'test_mock') {
      if (dryRun) return;
      for (const key of Array.from(mockObjects.keys())) {
        if (key.startsWith(`${bucketId}/`)) mockObjects.delete(key);
      }
      return;
    }

    try {
        await this.withBucketRLS(ref, token, async (tx) => {
            if (dryRun) {
                // Verify RLS allows deleting ALL objects: count total vs deletable
                const [{ total }] = await tx`SELECT COUNT(*)::int AS total FROM storage.objects WHERE bucket_id = ${bucketId}`;
                const deleted = await tx`DELETE FROM storage.objects WHERE bucket_id = ${bucketId} RETURNING id`;
                if (deleted.length < total) {
                    throw new Error("RLS_PARTIAL_DELETE");
                }
                throw new Error("DRY_RUN_ROLLBACK");
            }
            await tx`DELETE FROM storage.objects WHERE bucket_id = ${bucketId}`;
        });
    } catch (e: any) {
        if (e.message === 'DRY_RUN_ROLLBACK') return;
        if (e.message === 'RLS_PARTIAL_DELETE') throw new Error("You do not have permission to empty this bucket entirely");
        throw new Error(e.message || "Failed to empty bucket");
    }
  }
}
