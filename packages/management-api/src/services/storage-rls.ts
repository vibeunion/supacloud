import { getProjectDb, sql as metaSql } from "../db";
import { jwtVerify } from "jose";
import { logger } from "../utils/logger";


// ── TEST MOCK STATE ──
export const mockBuckets = new Map<string, any>();
export const mockObjects = new Map<string, any>();

export class StorageRLS {

  
  static async registerLogicalBucket(ref: string, token: string | undefined, bucketId: string, name: string, isPublic: boolean, fileSizeLimit?: number | null, allowedMimeTypes?: string[] | null): Promise<void> {
    if (ref === 'test_mock') {
      mockBuckets.set(bucketId, { id: bucketId, name, public: isPublic, file_size_limit: fileSizeLimit || null, allowed_mime_types: allowedMimeTypes || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return;
    }

    const formattedMimes = allowedMimeTypes && allowedMimeTypes.length > 0
        ? `{${allowedMimeTypes.map((m: string) => `"${m.replace(/"/g, '\\"')}"`).join(',')}}`
        : null;

    try {
        await this.withBucketRLS(ref, token, async (tx) => {
            await tx`
              INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at)
              VALUES (${bucketId}, ${name}, ${isPublic}, ${fileSizeLimit || null}, ${formattedMimes}, now(), now())
              ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, name = EXCLUDED.name, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types, updated_at = now()
            `;
        });
    } catch (e: any) {
        throw new Error(e.message || "Failed to create bucket");
    }
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
    const project = (await metaSql`SELECT db_name FROM projects WHERE ref=${ref}`)[0];
    if (!project) return;
    const db = getProjectDb(project.db_name);
    await db`DELETE FROM storage.buckets WHERE id = ${bucketId}`.catch(() => {});
  }

  
  static async getLogicalBucket(ref: string, bucketId: string, token: string | undefined): Promise<Record<string, unknown> | null> {
    if (ref === 'test_mock') return mockBuckets.get(bucketId) || null;

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

  static async getObjectInfo(ref: string, bucketId: string, objectName: string, token: string | undefined): Promise<Record<string, unknown> | null> {
    if (ref === 'test_mock') {
      const obj = mockObjects.get(bucketId + '/' + objectName);
      if (!obj) return null;
      return {
        id: bucketId + '/' + objectName,
        name: objectName,
        bucket_id: bucketId,
        size: obj.metadata?.size || 0,
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
      return {
        id: String(row.id),
        name: String(row.name),
        bucket_id: String(row.bucket_id),
        size: Number(meta.size || 0),
        cache_control: 'max-age=3600',
        content_type: String(meta.mimetype || 'application/octet-stream'),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        last_modified: String(row.updated_at),
        etag: `"${String(row.id).slice(0, 8)}"`,
        version: String(row.version || row.id),
        metadata: (meta.userMetadata || {}) as Record<string, unknown>,
      };
    }).catch(() => null);
  }

  static async getTenantJwtSecret(ref: string): Promise<string | null> {
    const rows = await metaSql`SELECT jwt_secret FROM projects WHERE ref=${ref}`;
    return rows[0]?.jwt_secret || null;
  }

  static async verifyToken(ref: string, token: string) {
    const secret = await this.getTenantJwtSecret(ref);
    if (!secret) throw new Error("tenant not found");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return payload;
  }

  
  
  static async withBucketRLS<T>(
    ref: string,
    token: string | null | undefined,
    callback: (tx: any, payload: any) => Promise<T>
  ): Promise<T> {
    const project = (await metaSql`SELECT db_name FROM projects WHERE ref=${ref}`)[0];
    if (!project) throw new Error("Project not found");
    
    const db = getProjectDb(project.db_name);
    
    let payload: Record<string, unknown> = { role: 'anon' };
    if (token) {
      try {
        payload = await this.verifyToken(ref, token.replace('Bearer ', ''));
      } catch (e) {
        throw new Error('Access Denied');
      }
    }

    return await db.begin(async (tx: any) => {
        await tx`SELECT set_config('role', ${(payload.role as string) || 'anon'}, true)`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(payload)}, true)`;
        if (payload.sub) await tx`SELECT set_config('request.jwt.claim.sub', ${String(payload.sub)}, true)`;
        if (payload.role) await tx`SELECT set_config('request.jwt.claim.role', ${String(payload.role)}, true)`;

        return await callback(tx, payload);
    });
  }

  static async authorizeAction(
    ref: string,
    token: string | null | undefined,
    action: 'upload' | 'download' | 'delete',
    bucketId: string,
    objectName: string,
    metadata: Record<string, unknown> = {},
    dryRun: boolean = false,
    upsert: boolean = true
  ): Promise<{ permitted: boolean, error?: string }> {
    if (ref === 'test_mock') {
       if (!mockBuckets.has(bucketId)) return { permitted: false, error: 'Bucket not found' };
       if (action === 'upload') {
           if (!upsert && mockObjects.has(bucketId + '/' + objectName)) {
               return { permitted: false, error: 'The resource already exists' };
           }
           if (!dryRun) mockObjects.set(bucketId + '/' + objectName, { metadata, updated: new Date().toISOString() });
       }
       if (action === 'download' || action === 'delete') {
           if (!mockObjects.has(bucketId + '/' + objectName)) return { permitted: false, error: 'Object not found' };
           if (action === 'delete') mockObjects.delete(bucketId + '/' + objectName);
       }
       return { permitted: true };
    }

    const project = (await metaSql`SELECT db_name FROM projects WHERE ref=${ref}`)[0];
    if (!project) return { permitted: false, error: 'Row Level Security violation or bucket missing. Access Denied.' };
    
    const db = getProjectDb(project.db_name);
    
    let payload: Record<string, unknown> = { role: 'anon' };
    if (token) {
      try {
        payload = await this.verifyToken(ref, token.replace('Bearer ', ''));
      } catch (e) {
        return { permitted: false, error: 'Row Level Security violation or bucket missing. Access Denied.' }; // Auth token invalid
      }
    }

    try {
      // Use a transaction so we respect standard RLS contexts
      await db.begin(async (tx) => {
        await tx`SELECT set_config('role', ${(payload.role as string) || 'anon'}, true)`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(payload)}, true)`;
        if (payload.sub) await tx`SELECT set_config('request.jwt.claim.sub', ${String(payload.sub)}, true)`;
        if (payload.role) await tx`SELECT set_config('request.jwt.claim.role', ${String(payload.role)}, true)`;

        // Prepare owner uuid safely (sometimes sub is not uuid)
        const owner = typeof payload.sub === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub) ? payload.sub : null;

        if (action === 'upload') {
          if (upsert) {
            const res = await tx`
              INSERT INTO storage.objects (bucket_id, name, owner, metadata)
              VALUES (${bucketId}, ${objectName}, ${owner}, ${ { ...metadata, userMetadata: metadata.userMetadata || {} } })
              ON CONFLICT (bucket_id, name)
              DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = now()
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
          
        } else if (action === 'delete') {
          // Attempt DELETE, returns id if RLS allowed the deletion
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
      });

      return { permitted: true };
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'DRY_RUN_ROLLBACK') {
        return { permitted: true };
      }
      if ((e as any).code === '23505') {
        return { permitted: false, error: 'The resource already exists' };
      }
      // If error is RLS related (row level security policy violation) or Postgres throws, deny
      logger.debug(`[StorageRLS] Action ${action} denied: ${e instanceof Error ? e.message : String(e)}`);
      return { permitted: false, error: e instanceof Error && e.message === 'RLS_VIOLATION_OR_NOT_FOUND' ? 'Object not found' : 'Row Level Security violation or bucket missing. Access Denied.' };
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
    search: string = ''
  ): Promise<any[]> {
    if (ref === 'test_mock') {
      const results = [];
      for (const [key, val] of mockObjects.entries()) {
         if (key.startsWith(bucketId + '/' + prefix)) {
            const name = key.substring(bucketId.length + 1);
            if (search && !name.toLowerCase().includes(search.toLowerCase())) continue;
            results.push({ id: key, name, updated: val.updated, size: val.metadata?.size || 0, type: val.metadata?.mimetype || 'unknown' });
         }
      }

      const sorted = results.sort((a, b) => {
        const column = sortBy?.column || 'name';
        const order = (sortBy?.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;

        if (column === 'updated_at') {
          return (new Date(a.updated).getTime() - new Date(b.updated).getTime()) * order;
        }
        if (column === 'metadata.size') {
          return ((Number(a.size) || 0) - (Number(b.size) || 0)) * order;
        }
        return String(a.name).localeCompare(String(b.name)) * order;
      });

      return sorted.slice(offset, offset + limit);
    }

    const project = (await metaSql`SELECT db_name FROM projects WHERE ref=${ref}`)[0];
    if (!project) return [];
    
    const db = getProjectDb(project.db_name);
    
    let payload: Record<string, unknown> = { role: 'anon' };
    if (token) {
      try { payload = await this.verifyToken(ref, token.replace('Bearer ', '')); } catch (e) {}
    }

    try {
      let results: any[] = [];
      await db.begin(async (tx) => {
        await tx`SELECT set_config('role', ${String(payload.role) || 'anon'}, true)`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(payload)}, true)`;
        if (payload.sub) await tx`SELECT set_config('request.jwt.claim.sub', ${String(payload.sub)}, true)`;
        if (payload.role) await tx`SELECT set_config('request.jwt.claim.role', ${String(payload.role)}, true)`;

        const searchPrefix = prefix + '%';
        const searchTerm = `%${search}%`;
        const orderColumn = sortBy?.column === 'updated_at'
          ? 'updated_at'
          : sortBy?.column === 'metadata.size'
            ? 'size'
            : 'name';
        const orderDirection = (sortBy?.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

        const baseRows = await tx`
          SELECT
            id,
            name,
            updated_at,
            metadata,
            COALESCE((metadata->>'size')::bigint, 0) AS size
          FROM storage.objects
          WHERE bucket_id = ${bucketId}
            AND name LIKE ${searchPrefix}
            AND (${search === ''} OR name ILIKE ${searchTerm})
        `;

        results = baseRows
          .sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
            const order = orderDirection === 'DESC' ? -1 : 1;
            if (orderColumn === 'updated_at') {
              return (new Date(String(a.updated_at)).getTime() - new Date(String(b.updated_at)).getTime()) * order;
            }
            if (orderColumn === 'size') {
              return ((Number(a.size) || 0) - (Number(b.size) || 0)) * order;
            }
            return String(a.name).localeCompare(String(b.name)) * order;
          })
          .slice(offset, offset + limit);
      });

      return results.map(row => {
          const sizeBytes = Number(row.metadata?.size || row.size || 0);
          return {
              id: row.id,
              name: row.name,
              updated: row.updated_at,
              size: sizeBytes,
              type: row.name.includes('.') ? row.name.split('.').pop() : 'unknown'
          };
      });
    } catch (e: unknown) {
      logger.error(`[StorageRLS] List access denied:`, { error: e instanceof Error ? e.message : String(e) });
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
            await tx`DELETE FROM storage.objects WHERE bucket_id = ${bucketId}`;
            if (dryRun) throw new Error("DRY_RUN_ROLLBACK");
        });
    } catch (e: any) {
        if (e.message === 'DRY_RUN_ROLLBACK') return;
        throw new Error(e.message || "Failed to empty bucket");
    }
  }
}
