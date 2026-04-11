import { sql } from "../db";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export interface TusUpload {
    ref: string;
    bucket: string;
    objectName: string;
    contentType: string;
    totalSize: number;
    offset: number;
    createdAt: number;
    auth_token?: string;
    meta?: Record<string, string>;
}

export interface SignedUpload {
    ref: string;
    bucket: string;
    objectName: string;
    upsert: boolean;
    expiresAt: number;
    auth_token?: string;
}

export class TusStore {
    static async set(id: string, upload: TusUpload) {
        await sql`
            INSERT INTO system_tus_uploads (id, ref, bucket, object_name, content_type, total_size, offset_size, auth_token)
            VALUES (${id}, ${upload.ref}, ${upload.bucket}, ${upload.objectName}, ${upload.contentType}, ${upload.totalSize}, ${upload.offset}, ${upload.auth_token || null})
            ON CONFLICT (id) DO UPDATE SET 
                offset_size = EXCLUDED.offset_size, 
                updated_at = NOW()
        `;
    }

    static async get(id: string): Promise<TusUpload | null> {
        const [row] = await sql`SELECT * FROM system_tus_uploads WHERE id = ${id}`;
        if (!row) return null;
        return {
            ref: row.ref,
            bucket: row.bucket,
            objectName: row.object_name,
            contentType: row.content_type,
            totalSize: Number(row.total_size),
            offset: Number(row.offset_size),
            createdAt: new Date(row.created_at).getTime(),
            auth_token: row.auth_token
        };
    }

    static async updateOffset(id: string, offset: number, newChunk: Buffer) {
        await sql.begin(async (tx) => {
            await tx`UPDATE system_tus_uploads SET offset_size = ${offset}, updated_at = NOW() WHERE id = ${id}`;
            await tx`INSERT INTO system_tus_chunks (upload_id, chunk_data, chunk_offset) VALUES (${id}, ${newChunk}, ${offset - newChunk.length})`;
        });
    }

    static async delete(id: string) {
        await sql`DELETE FROM system_tus_uploads WHERE id = ${id}`;
    }

    static async assembleToStream(id: string): Promise<{ stream: ReadableStream, cleanup: () => Promise<void> }> {
        const tempFile = path.join(os.tmpdir(), `supacloud-tus-${id}-${Date.now()}.tmp`);
        const file = Bun.file(tempFile);
        const writer = file.writer();
        
        // Fetch ordered offsets without loading payload
        const chunkOffsets = await sql`SELECT chunk_offset FROM system_tus_chunks WHERE upload_id = ${id} ORDER BY chunk_offset ASC`;
        
        for (const meta of chunkOffsets) {
            // Load and pipe 1 chunk at a time minimizing heap density
            const [row] = await sql`SELECT chunk_data FROM system_tus_chunks WHERE upload_id = ${id} AND chunk_offset = ${meta.chunk_offset}`;
            if (row && row.chunk_data) {
                writer.write(row.chunk_data);
            }
        }
        
        writer.end();

        return {
            stream: Bun.file(tempFile).stream(),
            cleanup: async () => {
                try {
                    await fs.promises.unlink(tempFile);
                } catch(e) {}
            }
        };
    }
}

export class SignedStore {
    static async set(token: string, upload: SignedUpload) {
        await sql`
            INSERT INTO system_signed_uploads (token, ref, bucket, object_name, upsert, expires_at, auth_token)
            VALUES (${token}, ${upload.ref}, ${upload.bucket}, ${upload.objectName}, ${upload.upsert}, ${upload.expiresAt}, ${upload.auth_token || null})
        `;
    }

    static async get(token: string): Promise<SignedUpload | null> {
        const [row] = await sql`SELECT * FROM system_signed_uploads WHERE token = ${token}`;
        if (!row) return null;
        return {
            ref: row.ref,
            bucket: row.bucket,
            objectName: row.object_name,
            upsert: row.upsert,
            expiresAt: Number(row.expires_at),
            auth_token: row.auth_token
        };
    }

    static async delete(token: string) {
        await sql`DELETE FROM system_signed_uploads WHERE token = ${token}`;
    }
}

// Cleanup job
export function startStorageCleanupJob() {
    setInterval(async () => {
        try {
            await sql`DELETE FROM system_tus_uploads WHERE created_at < NOW() - INTERVAL '1 hour'`;
            await sql`DELETE FROM system_signed_uploads WHERE expires_at < extract(epoch from NOW())`;
        } catch (e) {}
    }, 10 * 60 * 1000);
}
