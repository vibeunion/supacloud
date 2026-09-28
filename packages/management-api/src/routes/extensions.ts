import { jsonResponseSchema } from "../utils/json-response-schema";
import { Elysia, t, status } from "elysia";
import { extensionService } from '../services/extension.service';
import { requireAdminAuth, requireProjectOrAdminAuth } from '../middleware/auth';
import { logger } from "../utils/logger";
import { extensionOperationFailure } from "../services/extension-policy";

const ErrorResponse = t.Object({ message: t.String() });

export const extensionRoutes = new Elysia({ prefix: "/v1/projects/:ref/extensions" })
    .beforeHandle(async ({ params, request, set }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) { set.status = authError.status; return authError.body; }
    })
    .error(({ error, set }) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code.toUpperCase().replaceAll("-", "_") : "UNKNOWN";
        const failure = extensionOperationFailure(error);
        if (failure) { set.status = failure.status; return { message: failure.message }; }
        logger.error(`[Extensions] Unhandled error [${code}]:`, error);
        set.status = 500;
        return { message: "Internal server error", code: "INTERNAL_ERROR" };
    })
    .get('/', {
        response: { 200: jsonResponseSchema },
        detail: { tags: ["extensions"], summary: "List project extensions" },
    }, async ({ params }) => {
        return await extensionService.listExtensions(params.ref);
    })
    .post('/enable', {
        body: t.Object({ extension: t.String() }),
        response: { 200: jsonResponseSchema },
        detail: { tags: ["extensions"], summary: "Enable a project extension" },
    }, async ({ params, body }) => {
        return await extensionService.enableExtension(params.ref, body.extension);
    })
    .post('/disable', {
        body: t.Object({ extension: t.String() }),
        response: { 200: jsonResponseSchema },
        detail: { tags: ["extensions"], summary: "Disable a project extension" },
    }, async ({ params, body }) => {
        return await extensionService.disableExtension(params.ref, body.extension);
    })
    .patch('/', {
        body: t.Object({
            name: t.String(),
            create: t.Optional(t.Boolean()),
            drop: t.Optional(t.Boolean()),
            schema: t.Optional(t.String()),
            version: t.Optional(t.String()),
        }),
        response: { 200: jsonResponseSchema, 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Create or drop a project extension" },
    }, async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        if (body.create) {
            return await extensionService.enableExtension(params.ref, name, body.schema, body.version);
        }
        if (body.drop) {
            return await extensionService.disableExtension(params.ref, name);
        }
        return status(400, { message: "Must specify either 'create' or 'drop'", code: "400" });
    })
    .post('/', {
        body: t.Object({
            name: t.String(),
            schema: t.Optional(t.String()),
            version: t.Optional(t.String()),
        }),
        response: { 200: jsonResponseSchema, 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Create a project extension with options" },
    }, async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        return await extensionService.enableExtension(params.ref, name, body.schema, body.version);
    })
    .delete('/', {
        body: t.Object({ name: t.String() }),
        response: { 200: jsonResponseSchema, 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Delete a project extension" },
    }, async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        return await extensionService.disableExtension(params.ref, name);
    });

export const databaseExtensionRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/extensions" })
    .beforeHandle(async ({ params, request, set }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) { set.status = authError.status; return authError.body; }
    })
    .error(({ error, set }) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code.toUpperCase().replaceAll("-", "_") : "UNKNOWN";
        const failure = extensionOperationFailure(error);
        if (failure) { set.status = failure.status; return { message: failure.message }; }
        logger.error(`[DatabaseExtensions] Unhandled error [${code}]:`, error);
        set.status = 500;
        return { message: "Internal server error", code: "INTERNAL_ERROR" };
    })
    .get('', {
        response: { 200: jsonResponseSchema },
        detail: { tags: ["extensions"], summary: "List database extensions" },
    }, async ({ params }) => {
        return await extensionService.listExtensions(params.ref);
    })
    .get('/', {
        response: { 200: jsonResponseSchema },
        detail: { tags: ["extensions"], summary: "List database extensions" },
    }, async ({ params }) => {
        return await extensionService.listExtensions(params.ref);
    })
    .get('/catalog', ({ params }) => extensionService.listExtensionCatalog(params.ref))
    .post('/', {
        body: t.Object({
            name: t.String(),
            schema: t.Optional(t.String()),
            version: t.Optional(t.String()),
        }),
        response: { 200: jsonResponseSchema, 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Create a database extension" },
    }, async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        return await extensionService.enableExtension(params.ref, name, body.schema, body.version);
    })
    .patch('/', {
        body: t.Object({
            name: t.String(),
            create: t.Optional(t.Boolean()),
            drop: t.Optional(t.Boolean()),
            schema: t.Optional(t.String()),
            version: t.Optional(t.String()),
        }),
        response: { 200: jsonResponseSchema, 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Create or drop a database extension" },
    }, async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        if (body.create) {
            return await extensionService.enableExtension(params.ref, name, body.schema, body.version);
        }
        if (body.drop) {
            return await extensionService.disableExtension(params.ref, name);
        }
        return status(400, { message: "Must specify either 'create' or 'drop'", code: "400" });
    })
    .delete('/', {
        body: t.Object({ name: t.String() }),
        response: { 200: jsonResponseSchema, 400: ErrorResponse },
        detail: { tags: ["extensions"], summary: "Delete a database extension" },
    }, async ({ params, body }) => {
        const name = body.name;
        if (!name) return status(400, { message: "Extension name is required", code: "400" });
        return await extensionService.disableExtension(params.ref, name);
    });

export const systemExtensionRoutes = new Elysia({ prefix: "/v1/system/extensions" })
    .error(({ error, set }) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code.toUpperCase().replaceAll("-", "_") : "UNKNOWN";
        logger.error(`[SystemExtensions] Unhandled error [${code}]:`, error);
        set.status = 500;
        return { message: "Internal server error", code: "INTERNAL_ERROR" };
    })
    .get('/', {
        response: { 200: jsonResponseSchema },
        detail: { tags: ["extensions"], summary: "List available system extensions" },
    }, async () => {
        return await extensionService.listSystemExtensions();
    })
    .post('/install', {
        body: t.Object({ name: t.Optional(t.String()) }),
        response: {
            200: jsonResponseSchema,
            400: ErrorResponse,
        },
        detail: { tags: ["extensions"], summary: "Install a system extension" },
    }, async ({ body, request, set }) => {
        const authError = await requireAdminAuth(request);
        if (authError) { set.status = authError.status; return authError.body; }
        if (!body.name) return status(400, { message: "Extension package name is required", code: "400" });
        return await extensionService.installSystemExtension(body.name);
    })
    .post('/remove', {
        body: t.Object({ name: t.Optional(t.String()) }),
        response: {
            200: jsonResponseSchema,
            400: ErrorResponse,
        },
        detail: { tags: ["extensions"], summary: "Remove a system extension" },
    }, async ({ body, request, set }) => {
        const authError = await requireAdminAuth(request);
        if (authError) { set.status = authError.status; return authError.body; }
        if (!body.name) return status(400, { message: "Extension package name is required", code: "400" });
        return await extensionService.removeSystemExtension(body.name);
    });
