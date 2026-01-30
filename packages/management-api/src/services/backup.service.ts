import { exec } from 'child_process';
import { promisify } from 'util';
import { BackupInfo, RestoreRequest } from '../types/backup';
import path from 'path';

const execAsync = promisify(exec);
const BACKUP_MANAGER_PATH = path.resolve(process.cwd(), '../../scripts/lib/backup_manager.sh');

export class BackupService {
    /**
     * 获取备份列表
     * @param stanza 库名/实例名，默认为 db-main
     */
    static async listBackups(stanza: string = 'db-main'): Promise<BackupInfo[]> {
        try {
            const { stdout } = await execAsync(`bash ${BACKUP_MANAGER_PATH} list ${stanza}`);
            const rawData = JSON.parse(stdout);

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
        } catch (error) {
            console.error('Failed to list backups:', error);
            throw new Error('无法读取备份列表');
        }
    }

    /**
     * 创建新备份
     * @param stanza 库名
     * @param type 备份类型: full, incr, diff
     */
    static async createBackup(stanza: string = 'db-main', type: 'full' | 'incr' | 'diff' = 'incr'): Promise<{ message: string }> {
        try {
            // 备份是耗时操作，通常建议异步处理或流式输出
            // 这里简单返回启动成功的消息，实际可以结合 Task 系统
            exec(`bash ${BACKUP_MANAGER_PATH} create ${stanza} ${type}`);
            return { message: `已启动 ${type} 备份任务` };
        } catch (error) {
            console.error('Failed to create backup:', error);
            throw new Error('触发备份失败');
        }
    }

    /**
     * 执行 PITR 恢复
     * @param request 包含目标时间或 LSN
     */
    static async restore(request: RestoreRequest): Promise<{ message: string }> {
        try {
            // PITR 是危险且耗时的操作
            exec(`bash ${BACKUP_MANAGER_PATH} restore "${request.target}"`);
            return { message: `已启动点对点恢复 (PITR) 任务，目标: ${request.target}` };
        } catch (error) {
            console.error('Failed to initiate restore:', error);
            throw new Error('恢复操作启动失败');
        }
    }
}
