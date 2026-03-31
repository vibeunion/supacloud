import { getProjectDb, sql as metaSql } from "../db";
import { jwtVerify } from "jose";
import { logger } from "../utils/logger";

export class StorageRLS {
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

  static async authorizeAction(
    ref: string,
    token: string | null | undefined,
    action: 'upload' | 'download' | 'delete',
    bucketId: string,
    objectName: string,
    metadata: any = {}
  ): Promise<boolean> {
    const project = (await metaSql`SELECT db_name FROM projects WHERE ref=${ref}`)[0];
    if (!project) return false;
    
    const db = getProjectDb(project.db_name);
    
    let payload: any = { role: 'anon' };
    if (token) {
      try {
        payload = await this.verifyToken(ref, token.replace('Bearer ', ''));
      } catch (e) {
        return false; // Auth token invalid
      }
    }

    try {
      // Use a transaction so we respect standard RLS contexts
      await db.begin(async (tx) => {
        await tx`SELECT set_config('role', ${payload.role || 'anon'}, true)`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(payload)}, true)`;

        // Prepare owner uuid safely (sometimes sub is not uuid)
        const owner = payload.sub && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub) ? payload.sub : null;

        if (action === 'upload') {
          // Verify bucket exists first, otherwise foreign key fails, but bypassing for speed 
          // RLS ON CONFLICT handles Upsert logic:
          const res = await tx`
            INSERT INTO storage.objects (bucket_id, name, owner, metadata)
            VALUES (${bucketId}, ${objectName}, ${owner}, ${metadata as any})
            ON CONFLICT (bucket_id, name)
            DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = now()
            RETURNING id
          `;
          if (res.length === 0) throw new Error("RLS_VIOLATION");
          
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
      });

      return true;
    } catch (e: any) {
      // If error is RLS related (row level security policy violation) or Postgres throws, deny
      logger.debug(`[StorageRLS] Action ${action} denied: ${e.message}`);
      return false;
    }
  }

  static async listObjects(
    ref: string,
    token: string | null | undefined,
    bucketId: string,
    prefix: string = '',
    limit: number = 100,
    offset: number = 0
  ): Promise<any[]> {
    const project = (await metaSql`SELECT db_name FROM projects WHERE ref=${ref}`)[0];
    if (!project) return [];
    
    const db = getProjectDb(project.db_name);
    
    let payload: any = { role: 'anon' };
    if (token) {
      try { payload = await this.verifyToken(ref, token.replace('Bearer ', '')); } catch (e) {}
    }

    try {
      let results: any[] = [];
      await db.begin(async (tx) => {
        await tx`SELECT set_config('role', ${payload.role || 'anon'}, true)`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(payload)}, true)`;

        const searchPrefix = prefix + '%';
        results = await tx`
          SELECT id, name, updated_at, metadata
          FROM storage.objects
          WHERE bucket_id = ${bucketId} AND name LIKE ${searchPrefix}
          ORDER BY name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      });

      return results.map(row => {
          const sizeBytes = row.metadata?.size || 0;
          return {
              id: row.id,
              name: row.name,
              updated: row.updated_at,
              size: Math.round(sizeBytes / 1024) + ' KB',
              type: row.name.includes('.') ? row.name.split('.').pop() : 'unknown'
          };
      });
    } catch (e: any) {
      logger.error(`[StorageRLS] List access denied:`, { error: e.message || String(e) });
      return [];
    }
  }
}
