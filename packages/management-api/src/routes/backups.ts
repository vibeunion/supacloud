import { Elysia, t, status } from "elysia";
import {
    listBackups,
    createBackup,
    restore,
    PgBackRestUnavailableError,
    PitrRestoreUnavailableError,
    isPitrEnabled,
} from '../services/backup.service';
import {
    createLogicalBackup,
    listLogicalBackups,
    LogicalBackupContractError,
    restoreLogicalBackup,
} from "../services/logical-backup.service";
import { requireAdminAuth, requireProjectOrAdminAuth } from '../middleware/auth';
import { projectRepository } from '../repositories/project.repository';

const ErrorResponse = t.Object({ message: t.String() });

function logicalBackupErrorResponse(error: unknown) {
    if (!(error instanceof LogicalBackupContractError)) throw error;
    const errorStatus = {
        invalid_request: 400,
        not_found: 404,
        conflict: 409,
        unavailable: 503,
    }[error.kind] as 400 | 404 | 409 | 503;
    return status(errorStatus, { message: error.message });
}

const projectBackupRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/backups" })
    .get('/', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);

        const project = await projectRepository.findByRef(params.ref);
        if (!project) return status(404, { message: "Project not found" });
        try {
            return await listBackups(project.db_name);
        } catch (error) {
            if (error instanceof PgBackRestUnavailableError) {
                return status(503, { message: "pgBackRest backup inventory is unavailable" });
            }
            throw error;
        }
    }, {
        response: { 200: t.Any(), 404: ErrorResponse, 503: ErrorResponse },
        detail: { tags: ["backups"], summary: "List project backups" },
    })
    .post('/', async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const project = await projectRepository.findByRef(params.ref);
        if (!project) return status(404, { message: "Project not found" });
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
        response: { 200: t.Any(), 404: ErrorResponse, 503: ErrorResponse },
        detail: { tags: ["backups"], summary: "Create a database backup" },
    })
    .get('/logical', async ({ params: { ref }, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        try {
            return { backups: await listLogicalBackups(ref) };
        } catch (error: unknown) {
            return logicalBackupErrorResponse(error);
        }
    }, {
        response: { 200: t.Any(), 400: ErrorResponse, 404: ErrorResponse, 503: ErrorResponse },
        detail: { tags: ["backups"], summary: "List verified logical-full backups" },
    })
    .post('/logical', async ({ params: { ref }, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        try {
            return { backup: await createLogicalBackup(ref) };
        } catch (error: unknown) {
            return logicalBackupErrorResponse(error);
        }
    }, {
        response: { 200: t.Any(), 400: ErrorResponse, 404: ErrorResponse, 503: ErrorResponse },
        detail: { tags: ["backups"], summary: "Create a verified logical-full backup" },
    })
    .post('/logical/restore', async ({ params: { ref }, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        if (!body.backup_id || !body.expected_sha256 || !body.confirmation) {
            return status(400, {
                message: "backup_id, expected_sha256 and confirmation are required",
            });
        }
        const expectedConfirmation = [
            "RESTORE_PROJECT",
            ref,
            body.backup_id,
            body.expected_sha256,
        ].join(":");
        if (body.confirmation !== expectedConfirmation) {
            return status(400, { message: "Exact logical backup restore confirmation is required" });
        }
        try {
            const restoredBackup = await restoreLogicalBackup({
                project_ref: ref,
                backup_id: body.backup_id,
                expected_sha256: body.expected_sha256,
                confirmation: body.confirmation,
            });
            return { restored_backup: restoredBackup };
        } catch (error: unknown) {
            return logicalBackupErrorResponse(error);
        }
    }, {
        body: t.Object({
            backup_id: t.Optional(t.String()),
            expected_sha256: t.Optional(t.String()),
            confirmation: t.Optional(t.String()),
        }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
            503: ErrorResponse,
        },
        detail: { tags: ["backups"], summary: "Restore a verified logical-full backup" },
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
