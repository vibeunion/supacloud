import { shellService } from './shell.service';
import { BackupInfo, RestoreRequest } from '../types/backup';
import { projectRepository } from '../repositories/project.repository';
import { $ } from "bun";

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
    /**
     * 按租户级别执行逻辑备份 (pg_dump)
     * 将专属数据导出并可上传至对应的 S3 桶中
     */
    static async createLogicalBackup(projectRef: string): Promise<{ success: boolean; message: string; file?: string }> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error("Project not found");

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `backup_${projectRef}_${timestamp}.sql.gz`;
        const backupPath = `/tmp/${filename}`;

        try {
            // 使用租户角色，导出为 Custom 归档格式并带有默认 gzip 压缩
            const tenantUri = `postgres://${project.db_user}:${project.db_password}@localhost:5432/${project.db_name}`;

            console.log(`[LogicalBackup] Starting dump for ${projectRef} -> ${backupPath}`);
            await $`pg_dump ${tenantUri} -F c -Z 6 -f ${backupPath}`.quiet();

            // 尝试通过 AWS CLI (兼容 MinIO/Garage) 上传到租户的隐藏备份前缀
            if (project.s3_access_key && project.s3_secret_key) {
                try {
                    await $`AWS_ACCESS_KEY_ID=${project.s3_access_key} AWS_SECRET_ACCESS_KEY=${project.s3_secret_key} aws --endpoint-url http://localhost:9000 s3 cp ${backupPath} s3://${project.s3_bucket}/_backups/${filename}`.quiet();
                    console.log(`[LogicalBackup] Uploaded ${filename} to S3.`);
                    await $`rm -f ${backupPath}`.quiet(); // 上传成功后清理本地
                } catch (uploadErr) {
                    console.warn('[LogicalBackup] S3 Upload failed (Ensure awscli is installed). Kept local copy at', backupPath);
                }
            }

            return { success: true, message: "逻辑备份已完成", file: filename };
        } catch (err: any) {
            console.error("[LogicalBackup] failed:", err);
            return { success: false, message: "逻辑备份失败: " + err.message };
        }
    }

    /**
     * 按租户级别执行逻辑恢复 (pg_restore)
     */
    static async restoreLogicalBackup(projectRef: string, backupId: string): Promise<{ success: boolean; message: string }> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error("Project not found");

        const backupPath = `/tmp/${backupId}`;

        try {
            // 先尝试从 S3 下载
            if (project.s3_access_key && project.s3_secret_key) {
                try {
                    await $`AWS_ACCESS_KEY_ID=${project.s3_access_key} AWS_SECRET_ACCESS_KEY=${project.s3_secret_key} aws --endpoint-url http://localhost:9000 s3 cp s3://${project.s3_bucket}/_backups/${backupId} ${backupPath}`.quiet();
                    console.log(`[LogicalBackup] Downloaded ${backupId} from S3.`);
                } catch (dlErr) {
                    console.warn('[LogicalBackup] Could not download from S3, assuming local file exists.');
                }
            }

            // 检查文件存在
            const fileExists = await $`test -f ${backupPath}`.nothrow();
            if (fileExists.exitCode !== 0) {
                return { success: false, message: "未找到指定的备份文件: " + backupId };
            }

            // 执行 pg_restore (强制清除旧对象并在单一事务中完成)
            const tenantUri = `postgres://${project.db_user}:${project.db_password}@localhost:5432/${project.db_name}`;
            console.log(`[LogicalBackup] Starting restore for ${projectRef} from ${backupPath}`);

            // 使用 -c (clean) 清理原有数据, -1 (single-transaction)
            await $`pg_restore -d ${tenantUri} -c -1 ${backupPath}`.quiet();

            console.log(`[LogicalBackup] Restore complete for ${projectRef}`);
            return { success: true, message: "逻辑恢复成功完成" };
        } catch (err: any) {
            console.error("[LogicalBackup] Restore failed:", err);
            return { success: false, message: "恢复过程发生错误: " + err.message };
        } finally {
            // 清理本地临时文件
            await $`rm -f ${backupPath}`.nothrow().quiet();
        }
    }
}
