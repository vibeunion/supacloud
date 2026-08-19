import { Elysia, t, status } from "elysia";
import { extensionService } from '../services/extension.service';
import { requireAdminAuth, requireProjectOrAdminAuth } from '../middleware/auth';
import { logger } from "../utils/logger";

const ErrorResponse = t.Object({ message: t.String() });

export const extensionRoutes = new Elysia({ prefix: "/v1/projects/:ref/extensions" })
    .onBeforeHandle(async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
    })
    .onError(({ code, error, set }) => {
        logger.error(`[Extensions] Unhandled error [${code}]:`, error);
        set.status = 500;
        return { message: "Internal server error", code: "INTERNAL_ERROR" };
    })
    .get('/', async ({ params }) => {
        return await extensionService.listExtensions(params.ref);
    }, {
        response: { 200: t.Any() },
        detail: { tags: ["extensions"], summary: "List project extensions" },
    })
    .post('/enable', async ({ params, body }) => {
        return await extensionService.enableExtension(params.ref, body.extension);
    }, {
        body: t.Object({ extension: t.String() }),
        response: { 200: t.Any() },
        detail: { tags: ["extensions"], summary: "Enable a project extension" },
    })
    .post('/disable', async ({ params, body }) => {
        return await extensionService.disableExtension(params.ref, body.extension);
    }, {
        body: t.Object({ extension: t.String() }),
        response: { 200: t.Any() },
        detail: { tags: ["extensions"], summary: "Disable a project extension" },
    })
    .patch('/', async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        if (body.create) {
            return await extensionService.enableExtension(params.ref, name, body.schema, body.version);
        }
        if (body.drop) {
            return await extensionService.disableExtension(params.ref, name);
        }
        return status(400, { message: "Must specify either 'create' or 'drop'", code: "400" });
    }, {
        body: t.Object({
            name: t.String(),
            create: t.Optional(t.Boolean()),
            drop: t.Optional(t.Boolean()),
            schema: t.Optional(t.String()),
            version: t.Optional(t.String()),
        }),
        response: { 200: t.Any(), 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Create or drop a project extension" },
    })
    .post('/', async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        return await extensionService.enableExtension(params.ref, name, body.schema, body.version);
    }, {
        body: t.Object({
            name: t.String(),
            schema: t.Optional(t.String()),
            version: t.Optional(t.String()),
        }),
        response: { 200: t.Any(), 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Create a project extension with options" },
    })
    .delete('/', async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        return await extensionService.disableExtension(params.ref, name);
    }, {
        body: t.Object({ name: t.String() }),
        response: { 200: t.Any(), 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Delete a project extension" },
    });

export const databaseExtensionRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/extensions" })
    .onBeforeHandle(async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
    })
    .onError(({ code, error, set }) => {
        logger.error(`[DatabaseExtensions] Unhandled error [${code}]:`, error);
        set.status = 500;
        return { message: "Internal server error", code: "INTERNAL_ERROR" };
    })
    .get('/', async ({ params }) => {
        return await extensionService.listExtensions(params.ref);
    }, {
        response: { 200: t.Any() },
        detail: { tags: ["extensions"], summary: "List database extensions" },
    })
    .post('/', async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        return await extensionService.enableExtension(params.ref, name, body.schema, body.version);
    }, {
        body: t.Object({
            name: t.String(),
            schema: t.Optional(t.String()),
            version: t.Optional(t.String()),
        }),
        response: { 200: t.Any(), 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Create a database extension" },
    })
    .patch('/', async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        if (body.create) {
            return await extensionService.enableExtension(params.ref, name, body.schema, body.version);
        }
        if (body.drop) {
            return await extensionService.disableExtension(params.ref, name);
        }
        return status(400, { message: "Must specify either 'create' or 'drop'", code: "400" });
    }, {
        body: t.Object({
            name: t.String(),
            create: t.Optional(t.Boolean()),
            drop: t.Optional(t.Boolean()),
            schema: t.Optional(t.String()),
            version: t.Optional(t.String()),
        }),
        response: { 200: t.Any(), 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Create or drop a database extension" },
    })
    .delete('/', async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        return await extensionService.disableExtension(params.ref, name);
    }, {
        body: t.Object({ name: t.String() }),
        response: { 200: t.Any(), 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Delete a database extension" },
    });

export const systemExtensionRoutes = new Elysia({ prefix: "/v1/system/extensions" })
    .onError(({ code, error, set }) => {
        logger.error(`[SystemExtensions] Unhandled error [${code}]:`, error);
        set.status = 500;
        return { message: "Internal server error", code: "INTERNAL_ERROR" };
    })
    .get('/', async () => {
        return await extensionService.listSystemExtensions();
    }, {
        response: { 200: t.Any() },
        detail: { tags: ["extensions"], summary: "List available system extensions" },
    })
    .post('/install', async ({ body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        if (!body.name) return status(400, { message: "Extension package name is required", code: "400" });
        return await extensionService.installSystemExtension(body.name);
    }, {
        body: t.Object({ name: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
        detail: { tags: ["extensions"], summary: "Install a system extension" },
    })
    .post('/remove', async ({ body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        if (!body.name) return status(400, { message: "Extension package name is required", code: "400" });
        return await extensionService.removeSystemExtension(body.name);
    }, {
        body: t.Object({ name: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
        detail: { tags: ["extensions"], summary: "Remove a system extension" },
    });
