import { Elysia, t, status } from "elysia";
import { listBackups, createBackup, restore, createLogicalBackup, restoreLogicalBackup } from '../services/backup.service';
import type { RestoreRequest } from '../types/backup';
import { resolveDbName } from '../db';
import { requireAdminAuth, requireProjectOrAdminAuth } from '../middleware/auth';

const ErrorResponse = t.Object({ message: t.String() });

export const backupRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/backups" })
    .get('/', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);

        const dbName = await resolveDbName(params.ref);
        return await listBackups(dbName);
    }, {
        response: { 200: t.Any() },
        detail: { tags: ["backups"], summary: "List project backups" },
    })
    .post('/', async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const dbName = await resolveDbName(params.ref);
        return await createBackup(dbName, body.type);
    }, {
        body: t.Object({
            type: t.Optional(t.Union([
                t.Literal('full'),
                t.Literal('incr'),
                t.Literal('diff'),
            ])),
        }),
        response: { 200: t.Any() },
        detail: { tags: ["backups"], summary: "Create a database backup" },
    })
    .post('/restore', async ({ body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        try {
            return await restore(body as RestoreRequest);
        } catch (err) {
            return status(400, { message: err instanceof Error ? err.message : "Invalid restore request" });
        }
    }, {
        body: t.Object({ target: t.String() }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
        detail: { tags: ["backups"], summary: "Restore from backup" },
    })
    .post('/logical', async ({ params: { ref }, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        return await createLogicalBackup(ref);
    }, {
        response: { 200: t.Any() },
        detail: { tags: ["backups"], summary: "Create a logical backup" },
    })
    .post('/logical/restore', async ({ params: { ref }, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        if (!body.backupId) return status(400, { message: "backupId is required", code: "400" });
        return await restoreLogicalBackup(ref, body.backupId);
    }, {
        body: t.Object({ backupId: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
        detail: { tags: ["backups"], summary: "Restore from logical backup" },
    });
