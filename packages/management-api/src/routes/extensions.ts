import { Elysia, t, status } from "elysia";
import { extensionService } from '../services/extension.service';

const ErrorResponse = t.Object({ error: t.String() });

export const extensionRoutes = new Elysia({ prefix: "/v1/projects/:ref/extensions" })
    .get('/', async ({ params }) => {
        return await extensionService.listExtensions(params.ref);
    }, {
        response: { 200: t.Any() },
    })
    .post('/enable', async ({ params, body }) => {
        return await extensionService.enableExtension(params.ref, body.extension);
    }, {
        body: t.Object({ extension: t.String() }),
        response: { 200: t.Any() },
    })
    .post('/disable', async ({ params, body }) => {
        return await extensionService.disableExtension(params.ref, body.extension);
    }, {
        body: t.Object({ extension: t.String() }),
        response: { 200: t.Any() },
    });

// System-level extension management (platform admin)
export const systemExtensionRoutes = new Elysia({ prefix: "/v1/system/extensions" })
    .get('/', async () => {
        return await extensionService.listSystemExtensions();
    }, {
        response: { 200: t.Any() },
    })
    .post('/install', async ({ body }) => {
        if (!body.name) return status(400, { error: "Extension package name is required" });
        return await extensionService.installSystemExtension(body.name);
    }, {
        body: t.Object({ name: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
    })
    .post('/remove', async ({ body }) => {
        if (!body.name) return status(400, { error: "Extension package name is required" });
        return await extensionService.removeSystemExtension(body.name);
    }, {
        body: t.Object({ name: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
    });
