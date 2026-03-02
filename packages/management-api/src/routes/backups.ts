import { Elysia, t } from "elysia";
import { BackupService } from '../services/backup.service';
import { RestoreRequest } from '../types/backup';

export const backupRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/backups" })
    .get('/', async ({ params, query }: any) => {
        // stanza is usually the tenant database supa_<ref> for the project, simplified here for compatibility,
        // in future evolution should remove stanza parameter, only pass projectRef.
        const stanza = query.stanza || `supa_${params.ref}`;
        return await BackupService.listBackups(stanza);
    })
    .post('/', async ({ params, body }: any) => {
        const stanza = body.stanza || `supa_${params.ref}`;
        const type = body.type;
        return await BackupService.createBackup(stanza, type);
    })
    .post('/restore', async ({ body }: any) => {
        return await BackupService.restore(body as RestoreRequest);
    })
    // --- Tenant-level logical backup routes ---
    .post('/logical', async ({ params: { ref } }: any) => {
        return await BackupService.createLogicalBackup(ref);
    })
    .post('/logical/restore', async ({ params: { ref }, body }: any) => {
        const backupId = body.backupId;
        if (!backupId) throw new Error("backupId is required");
        return await BackupService.restoreLogicalBackup(ref, backupId);
    });
