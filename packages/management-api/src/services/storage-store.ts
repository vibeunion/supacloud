import { sql } from "../db";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

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
    static getTempFilePath(id: string): string {
        return path.join(os.tmpdir(), `supacloud-tus-${id}.part`);
    }

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

    static async appendChunk(id: string, expectedOffset: number, chunk: ReadableStream<Uint8Array>): Promise<number> {
        const tempFile = this.getTempFilePath(id);
        await fsp.mkdir(path.dirname(tempFile), { recursive: true });

        const existingSize = await fsp.stat(tempFile).then((stat) => stat.size).catch(() => 0);
        if (existingSize !== expectedOffset) {
            throw new Error(`Offset mismatch: expected ${expectedOffset}, actual ${existingSize}`);
        }

        const handle = await fsp.open(tempFile, expectedOffset === 0 ? "w" : "r+");
        let bytesWritten = 0;
        let position = expectedOffset;

        try {
            const reader = chunk.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const data = value instanceof Uint8Array ? value : new Uint8Array(value);
                if (data.byteLength === 0) continue;
                await handle.write(data, 0, data.byteLength, position);
                position += data.byteLength;
                bytesWritten += data.byteLength;
            }
        } finally {
            await handle.close();
        }

        const nextOffset = expectedOffset + bytesWritten;
        await sql`UPDATE system_tus_uploads SET offset_size = ${nextOffset}, updated_at = NOW() WHERE id = ${id}`;
        return nextOffset;
    }

    static async delete(id: string) {
        await fsp.unlink(this.getTempFilePath(id)).catch(() => {});
        await sql`DELETE FROM system_tus_chunks WHERE upload_id = ${id}`.catch(() => {});
        await sql`DELETE FROM system_tus_uploads WHERE id = ${id}`;
    }

    static async assembleToStream(id: string): Promise<{ stream: ReadableStream, cleanup: () => Promise<void> }> {
        const tempFile = this.getTempFilePath(id);
        await fsp.access(tempFile);

        return {
            stream: Bun.file(tempFile).stream(),
            cleanup: async () => {
                try {
                    await fsp.unlink(tempFile);
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
            const expiredTusUploads = await sql`SELECT id FROM system_tus_uploads WHERE created_at < NOW() - INTERVAL '1 hour'`;
            for (const upload of expiredTusUploads as Array<{ id: string }>) {
                await fsp.unlink(TusStore.getTempFilePath(upload.id)).catch(() => {});
            }
            await sql`DELETE FROM system_tus_chunks WHERE upload_id IN (SELECT id FROM system_tus_uploads WHERE created_at < NOW() - INTERVAL '1 hour')`.catch(() => {});
            await sql`DELETE FROM system_tus_uploads WHERE created_at < NOW() - INTERVAL '1 hour'`;
            await sql`DELETE FROM system_signed_uploads WHERE expires_at < extract(epoch from NOW())`;
        } catch (e) {}
    }, 10 * 60 * 1000);
}
