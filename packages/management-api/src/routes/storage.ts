import { Elysia } from "elysia";
import { StorageService } from '../services/storage.service';

export const storageRoutes = new Elysia({ prefix: "/v1/storage" })
    .get('/status', async () => {
        return await StorageService.getStatus();
    })
    .get('/:ref/buckets', async ({ params }) => {
        return await StorageService.listBuckets(params.ref);
    })
    .get('/:ref/buckets/:name/files', async ({ params }) => {
        return await StorageService.listFiles(params.ref, params.name);
    })
    .post('/:ref/buckets/:name/upload', async ({ params, body }) => {
        const file = (body as any)?.file as File;
        if (!file) throw new Error('No file provided');
        const fileData = Buffer.from(await file.arrayBuffer());
        const success = await StorageService.uploadFile(params.ref, params.name, file.name, fileData, file.type);
        if (!success) throw new Error('Failed to upload file');
        return { success: true, message: 'File uploaded successfully' };
    })
    .delete('/:ref/buckets/:name/files/:filename', async ({ params }) => {
        const success = await StorageService.deleteFile(params.ref, params.name, params.filename);
        if (!success) throw new Error('Failed to delete file');
        return { success: true, message: 'File deleted successfully' };
    })
    .post('/migrate', async ({ body }: any) => {
        const { s3Url, credentials } = body as { s3Url: string, credentials: { access_key: string, secret_key: string, endpoint: string } };
        if (!s3Url || !credentials) throw new Error('Missing migration parameters');
        return await StorageService.startMigration(s3Url, credentials);
    });
