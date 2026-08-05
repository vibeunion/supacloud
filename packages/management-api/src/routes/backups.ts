import { Elysia, t, status } from "elysia";
import {
    listBackups,
    createBackup,
    restore,
    createLogicalBackup,
    restoreLogicalBackup,
    PgBackRestUnavailableError,
    PitrRestoreUnavailableError,
    isPitrEnabled,
} from '../services/backup.service';
import { resolveDbName } from '../db';
import { requireAdminAuth, requireProjectOrAdminAuth } from '../middleware/auth';

const ErrorResponse = t.Object({ message: t.String() });

const projectBackupRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/backups" })
    .get('/', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);

        const dbName = await resolveDbName(params.ref);
        try {
            return await listBackups(dbName);
        } catch (error) {
            if (error instanceof PgBackRestUnavailableError) {
                return status(503, { message: "pgBackRest backup inventory is unavailable" });
            }
            throw error;
        }
    }, {
        response: { 200: t.Any(), 503: ErrorResponse },
        detail: { tags: ["backups"], summary: "List project backups" },
    })
    .post('/', async ({ body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        try {
            return await createBackup(body.type);
        } catch (error) {
            if (error instanceof PgBackRestUnavailableError) {
                return status(503, { message: "pgBackRest backup failed" });
            }
            throw error;
        }
    }, {
        body: t.Object({
            type: t.Optional(t.Union([
                t.Literal('full'),
                t.Literal('incr'),
                t.Literal('diff'),
            ])),
        }),
        response: { 200: t.Any(), 503: ErrorResponse },
        detail: { tags: ["backups"], summary: "Create a database backup" },
    })
    .post('/logical', async ({ params: { ref }, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const backup = await createLogicalBackup(ref);
        if (!backup.success) return status(503, { message: backup.message });
        return backup;
    }, {
        response: { 200: t.Any(), 503: ErrorResponse },
        detail: { tags: ["backups"], summary: "Create a logical backup" },
    })
    .post('/logical/restore', async ({ params: { ref }, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        if (!body.backupId) return status(400, { message: "backupId is required", code: "400" });
        if (body.confirmation !== `RESTORE_PROJECT:${ref}:${body.backupId}`) {
            return status(400, { message: "Exact project restore confirmation is required" });
        }
        const restoreResult = await restoreLogicalBackup(ref, body.backupId);
        if (restoreResult.success) return restoreResult;
        if (restoreResult.reason === "project_not_paused") return status(409, { message: restoreResult.message });
        if (restoreResult.reason === "backup_not_found") return status(404, { message: restoreResult.message });
        if (restoreResult.reason === "invalid_backup_id") return status(400, { message: restoreResult.message });
        return status(503, { message: restoreResult.message });
    }, {
        body: t.Object({
            backupId: t.Optional(t.String()),
            confirmation: t.Optional(t.String()),
        }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
            503: ErrorResponse,
        },
        detail: { tags: ["backups"], summary: "Restore from logical backup" },
    });

export const backupRoutes = new Elysia()
    .use(projectBackupRoutes)
    .post('/v1/platform/backups/restore', async ({ body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        if (body.confirmation !== `RESTORE_CLUSTER:${body.target}`) {
            return status(400, { message: "Exact cluster restore confirmation is required" });
        }
        if (!isPitrEnabled()) {
            return status(409, { message: "Physical PITR is not enabled for this cluster" });
        }
        try {
            const backups = await listBackups();
            if (!backups.some((backup) => backup.timestamp.stop > 0)) {
                return status(409, { message: "No completed physical backup is available for PITR" });
            }
            return await restore({ target: body.target });
        } catch (err) {
            if (err instanceof PgBackRestUnavailableError) {
                return status(503, { message: "pgBackRest backup inventory is unavailable" });
            }
            if (err instanceof PitrRestoreUnavailableError) {
                return status(503, { message: err.message });
            }
            return status(400, { message: err instanceof Error ? err.message : "Invalid restore request" });
        }
    }, {
        body: t.Object({ target: t.String(), confirmation: t.String() }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
            409: ErrorResponse,
            503: ErrorResponse,
        },
        detail: { tags: ["backups"], summary: "Restore the physical cluster to a point in time" },
    });
