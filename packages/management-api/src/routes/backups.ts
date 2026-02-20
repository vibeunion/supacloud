import { BackupService } from '../services/backup.service';
import { RestoreRequest } from '../types/backup';

export const backupRoutes = (app: any) =>
    app.group('/backups', (app: any) =>
        app
            .get('/', async ({ query }: any) => {
                const stanza = query.stanza || 'db-main';
                return await BackupService.listBackups(stanza);
            })
            .post('/', async ({ body }: any) => {
                const { stanza, type } = body as { stanza?: string; type?: 'full' | 'incr' | 'diff' };
                return await BackupService.createBackup(stanza, type);
            })
            .post('/restore', async ({ body }: any) => {
                return await BackupService.restore(body as RestoreRequest);
            })
            // --- 租户级逻辑备份路由 ---
            .post('/logical/:projectRef', async ({ params: { projectRef } }: any) => {
                return await BackupService.createLogicalBackup(projectRef);
            })
            .post('/logical/:projectRef/restore', async ({ params: { projectRef }, body }: any) => {
                const { backupId } = body as { backupId: string };
                if (!backupId) throw new Error("backupId is required");
                return await BackupService.restoreLogicalBackup(projectRef, backupId);
            })
    );
