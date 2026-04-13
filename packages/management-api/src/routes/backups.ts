import { Elysia, t, status } from "elysia";
import { listBackups, createBackup, restore, createLogicalBackup, restoreLogicalBackup } from '../services/backup.service';
import type { RestoreRequest } from '../types/backup';
import { resolveDbName } from '../db';

const ErrorResponse = t.Object({ message: t.String() });

export const backupRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/backups" })
    .get('/', async ({ params, query }) => {
        const dbName = await resolveDbName(params.ref);
        const stanza = query.stanza || dbName;
        return await listBackups(stanza);
    }, {
        query: t.Object({ stanza: t.Optional(t.String()) }),
        response: { 200: t.Any() },
    })
    .post('/', async ({ params, body }) => {
        const dbName = await resolveDbName(params.ref);
        const stanza = body.stanza || dbName;
        return await createBackup(stanza, body.type);
    }, {
        body: t.Object({
            stanza: t.Optional(t.String()),
            type: t.Optional(t.Union([
                t.Literal('full'),
                t.Literal('incr'),
                t.Literal('diff'),
            ])),
        }),
        response: { 200: t.Any() },
    })
    .post('/restore', async ({ body }) => {
        return await restore(body as RestoreRequest);
    }, {
        response: { 200: t.Any() },
    })
    .post('/logical', async ({ params: { ref } }) => {
        return await createLogicalBackup(ref);
    }, {
        response: { 200: t.Any() },
    })
    .post('/logical/restore', async ({ params: { ref }, body }) => {
        if (!body.backupId) return status(400, { message: "backupId is required", code: "400" });
        return await restoreLogicalBackup(ref, body.backupId);
    }, {
        body: t.Object({ backupId: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
    });
