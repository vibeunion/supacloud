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

// System-level extension management (platform admin)
export const systemExtensionRoutes = new Elysia({ prefix: "/v1/system/extensions" })
    .get('/', async () => {
        return await extensionService.listSystemExtensions();
    })
    .post('/install', async ({ body }: any) => {
        const name = body.name;
        if (!name) throw new Error("Extension package name is required");
        return await extensionService.installSystemExtension(name);
    })
    .post('/remove', async ({ body }: any) => {
        const name = body.name;
        if (!name) throw new Error("Extension package name is required");
        return await extensionService.removeSystemExtension(name);
    });
