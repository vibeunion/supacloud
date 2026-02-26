import { Elysia, t } from "elysia";
import { BackupService } from '../services/backup.service';
import { RestoreRequest } from '../types/backup';

export const backupRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/backups" })
    .get('/', async ({ params, query }: any) => {
        // stanza 通常就是项目对应的租户数据库 supa_<ref>，这里作简化兼容处理，
        // 在未来的演进中应该移除 stanza 参数，只传 projectRef。
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
    // --- 租户级逻辑备份路由 ---
    .post('/logical', async ({ params: { ref } }: any) => {
        return await BackupService.createLogicalBackup(ref);
    })
    .post('/logical/restore', async ({ params: { ref }, body }: any) => {
        const backupId = body.backupId;
        if (!backupId) throw new Error("backupId is required");
        return await BackupService.restoreLogicalBackup(ref, backupId);
    });
