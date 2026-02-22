import { Elysia } from "elysia";
import { ExtensionService } from '../services/extension.service';

export const extensionRoutes = new Elysia({ prefix: "/v1/projects/:ref/extensions" })
    .get('/', async ({ params }: any) => {
        return await ExtensionService.listExtensions(params.ref);
    })
    .post('/enable', async ({ params, body }: any) => {
        const extension = body.extension;
        return await ExtensionService.enableExtension(params.ref, extension);
    })
    .post('/disable', async ({ params, body }: any) => {
        const extension = body.extension;
        return await ExtensionService.disableExtension(params.ref, extension);
    });
