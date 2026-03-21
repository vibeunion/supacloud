import { Elysia, t, status } from "elysia";
import { StorageService } from '../services/storage.service';

const ErrorResponse = t.Object({ error: t.String() });
const SuccessResponse = t.Object({ success: t.Boolean(), message: t.String() });

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
        const file = body.file;
        if (!file) return status(400, { error: 'No file provided' });
        const fileData = Buffer.from(await file.arrayBuffer());
        const success = await StorageService.uploadFile(params.ref, params.name, file.name, fileData, file.type);
        if (!success) return status(500, { error: 'Failed to upload file' });
        return { success: true, message: 'File uploaded successfully' };
    }, {
        body: t.Object({ file: t.File() }),
        response: {
            200: SuccessResponse,
            400: ErrorResponse,
            500: ErrorResponse,
        },
    })
    .delete('/:ref/buckets/:name/files/:filename', async ({ params }) => {
        const success = await StorageService.deleteFile(params.ref, params.name, params.filename);
        if (!success) return status(500, { error: 'Failed to delete file' });
        return { success: true, message: 'File deleted successfully' };
    }, {
        response: {
            200: SuccessResponse,
            500: ErrorResponse,
        },
    })
    .post('/migrate', async ({ body }) => {
        if (!body.s3Url || !body.credentials) return status(400, { error: 'Missing migration parameters' });
        return await StorageService.startMigration(body.s3Url, body.credentials);
    }, {
        body: t.Object({
            s3Url: t.String(),
            credentials: t.Object({
                access_key: t.String(),
                secret_key: t.String(),
                endpoint: t.String(),
            }),
        }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
    });
