import { shellService } from './shell.service';
import { BackupInfo, RestoreRequest } from '../types/backup';

export class BackupService {
    /**
     * 获取备份列表
     * @param stanza 库名/实例名，默认为 db-main
     */
    static async listBackups(stanza: string = 'db-main'): Promise<BackupInfo[]> {
        const { success, output, error } = await shellService.execute('backup_manager.sh', ['list', stanza]);

        if (!success) {
            console.error('Failed to list backups:', error);
            throw new Error('无法读取备份列表');
        }

        try {
            const rawData = JSON.parse(output);

            // 解析 pgBackRest 的 JSON 输出
            if (!Array.isArray(rawData) || rawData.length === 0) return [];

            const backups = rawData[0].backup || [];
            return backups.map((b: any) => ({
                id: b.label,
                type: b.type,
                timestamp: {
                    start: b.timestamp.start,
                    stop: b.timestamp.stop,
                },
                size: b.info.size.backup,
                database: rawData[0].name,
            }));
        } catch (e) {
            console.error('Failed to parse backup list:', e);
            throw new Error('解析备份列表失败');
        }
    }

    /**
     * 创建新备份
     * @param stanza 库名
     * @param type 备份类型: full, incr, diff
     */
    static async createBackup(stanza: string = 'db-main', type: 'full' | 'incr' | 'diff' = 'incr'): Promise<{ message: string }> {
        // 备份是耗时操作，通常建议异步处理
        // shellService.execute 是 await 的，但为了不阻塞 API，我们可以异步调用
        shellService.execute('backup_manager.sh', ['create', stanza, type]).catch(err => {
            console.error('Async backup task failed:', err);
        });

        return { message: `已启动 ${type} 备份任务` };
    }

    /**
     * 执行 PITR 恢复
     * @param request 包含目标时间或 LSN
     */
    static async restore(request: RestoreRequest): Promise<{ message: string }> {
        // PITR 是危险且耗时的操作
        shellService.execute('backup_manager.sh', ['restore', request.target]).catch(err => {
            console.error('Async restore task failed:', err);
        });

        return { message: `已启动点对点恢复 (PITR) 任务，目标: ${request.target}` };
    }
}
