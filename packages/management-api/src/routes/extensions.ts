import { Elysia } from "elysia";
import { extensionService } from '../services/extension.service';

export const extensionRoutes = new Elysia({ prefix: "/v1/projects/:ref/extensions" })
    .get('/', async ({ params }: any) => {
        return await extensionService.listExtensions(params.ref);
    })
    .post('/enable', async ({ params, body }: any) => {
        const extension = body.extension;
        return await extensionService.enableExtension(params.ref, extension);
    })
    .post('/disable', async ({ params, body }: any) => {
        const extension = body.extension;
        return await extensionService.disableExtension(params.ref, extension);
    });
