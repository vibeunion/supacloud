import { sql } from "../db";

export interface TusUpload {
    ref: string;
    bucket: string;
    objectName: string;
    contentType: string;
    totalSize: number;
    offset: number;
    createdAt: number;
}

export interface SignedUpload {
    ref: string;
    bucket: string;
    objectName: string;
    upsert: boolean;
    expiresAt: number;
}

export class TusStore {
    static async set(id: string, upload: TusUpload) {
        await sql`
            INSERT INTO system_tus_uploads (id, ref, bucket, object_name, content_type, total_size, offset_size)
            VALUES (${id}, ${upload.ref}, ${upload.bucket}, ${upload.objectName}, ${upload.contentType}, ${upload.totalSize}, ${upload.offset})
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
            createdAt: new Date(row.created_at).getTime()
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

    static async assemble(id: string): Promise<Buffer> {
        const chunks = await sql`SELECT chunk_data FROM system_tus_chunks WHERE upload_id = ${id} ORDER BY chunk_offset ASC`;
        return Buffer.concat(chunks.map((r: any) => r.chunk_data));
    }
}

export class SignedStore {
    static async set(token: string, upload: SignedUpload) {
        await sql`
            INSERT INTO system_signed_uploads (token, ref, bucket, object_name, upsert, expires_at)
            VALUES (${token}, ${upload.ref}, ${upload.bucket}, ${upload.objectName}, ${upload.upsert}, ${upload.expiresAt})
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
            expiresAt: Number(row.expires_at)
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
