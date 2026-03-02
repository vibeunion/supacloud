import { $ } from 'bun';
import { BackupInfo, RestoreRequest } from '../types/backup';
import { projectRepository } from '../repositories/project.repository';

export class BackupService {
    /**
     * Get backup list
     * @param stanza Database name/instance name, defaults to db-main
     */
    static async listBackups(stanza: string = 'db-main'): Promise<BackupInfo[]> {
        const result = await $`sudo -u postgres pgbackrest --stanza=${stanza} info --output=json`.nothrow().quiet();

        if (result.exitCode !== 0) {
            // Return empty list when pgbackrest is not installed
            console.warn('[Backup] pgbackrest not available or no backups found');
            return [];
        }

        try {
            const rawData = JSON.parse(result.text());
            if (!Array.isArray(rawData) || rawData.length === 0) return [];
            const backups = rawData[0].backup || [];
            return backups.map((b: any) => ({
                id: b.label,
                type: b.type,
                timestamp: { start: b.timestamp.start, stop: b.timestamp.stop },
                size: b.info.size.backup,
                database: rawData[0].name,
            }));
        } catch (e) {
            console.error('Failed to parse backup list:', e);
            throw new Error('Failed to parse backup list');
        }
    }

    static async createBackup(stanza: string = 'db-main', type: 'full' | 'incr' | 'diff' = 'incr'): Promise<{ message: string }> {
        $`sudo -u postgres pgbackrest --stanza=${stanza} --type=${type} backup`.nothrow().quiet().catch(err => {
            console.error('[Backup] Async backup task failed:', err);
        });
        return { message: `${type} backup task started` };
    }

    static async restore(request: RestoreRequest): Promise<{ message: string }> {
        $`sudo -u postgres pig pitr ${request.target}`.nothrow().quiet().catch(err => {
            console.error('[Backup] Async restore task failed:', err);
        });
        return { message: `Point-in-time recovery (PITR) task started, target: ${request.target}` };
    }
    /**
     * Execute logical backup per tenant level (pg_dump)
     * Export dedicated data and upload to corresponding S3 bucket
     */
    static async createLogicalBackup(projectRef: string): Promise<{ success: boolean; message: string; file?: string }> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error("Project not found");

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `backup_${projectRef}_${timestamp}.sql.gz`;
        const backupPath = `/tmp/${filename}`;

        try {
            // Use tenant role, export as Custom archive format with default gzip compression
            const tenantUri = `postgres://${project.db_user}:${project.db_password}@localhost:5432/${project.db_name}`;

            console.log(`[LogicalBackup] Starting dump for ${projectRef} -> ${backupPath}`);
            await $`pg_dump ${tenantUri} -F c -Z 6 -f ${backupPath}`.quiet();

            // Try to upload to tenant's hidden backup prefix via AWS CLI (MinIO/Garage compatible)
            if (project.s3_access_key && project.s3_secret_key) {
                try {
                    await $`AWS_ACCESS_KEY_ID=${project.s3_access_key} AWS_SECRET_ACCESS_KEY=${project.s3_secret_key} aws --endpoint-url http://localhost:9000 s3 cp ${backupPath} s3://${project.s3_bucket}/_backups/${filename}`.quiet();
                    console.log(`[LogicalBackup] Uploaded ${filename} to S3.`);
                    await $`rm -f ${backupPath}`.quiet(); // Cleanup local after successful upload
                } catch (uploadErr) {
                    console.warn('[LogicalBackup] S3 Upload failed (Ensure awscli is installed). Kept local copy at', backupPath);
                }
            }

            return { success: true, message: "Logical backup completed", file: filename };
        } catch (err: any) {
            console.error("[LogicalBackup] failed:", err);
            return { success: false, message: "Logical backup failed: " + err.message };
        }
    }

    /**
     * Execute logical restore per tenant level (pg_restore)
     */
    static async restoreLogicalBackup(projectRef: string, backupId: string): Promise<{ success: boolean; message: string }> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error("Project not found");

        const backupPath = `/tmp/${backupId}`;

        try {
            // Try downloading from S3 first
            if (project.s3_access_key && project.s3_secret_key) {
                try {
                    await $`AWS_ACCESS_KEY_ID=${project.s3_access_key} AWS_SECRET_ACCESS_KEY=${project.s3_secret_key} aws --endpoint-url http://localhost:9000 s3 cp s3://${project.s3_bucket}/_backups/${backupId} ${backupPath}`.quiet();
                    console.log(`[LogicalBackup] Downloaded ${backupId} from S3.`);
                } catch (dlErr) {
                    console.warn('[LogicalBackup] Could not download from S3, assuming local file exists.');
                }
            }

            // Check file exists
            const fileExists = await $`test -f ${backupPath}`.nothrow();
            if (fileExists.exitCode !== 0) {
                return { success: false, message: "Backup file not found: " + backupId };
            }

            // Execute pg_restore (force clean old objects and complete in single transaction)
            const tenantUri = `postgres://${project.db_user}:${project.db_password}@localhost:5432/${project.db_name}`;
            console.log(`[LogicalBackup] Starting restore for ${projectRef} from ${backupPath}`);

            // Use -c (clean) to cleanup existing data, -1 (single-transaction)
            await $`pg_restore -d ${tenantUri} -c -1 ${backupPath}`.quiet();

            console.log(`[LogicalBackup] Restore complete for ${projectRef}`);
            return { success: true, message: "Logical restore completed successfully" };
        } catch (err: any) {
            console.error("[LogicalBackup] Restore failed:", err);
            return { success: false, message: "Restore process error: " + err.message };
        } finally {
            // Cleanup local temp file
            await $`rm -f ${backupPath}`.nothrow().quiet();
        }
    }
}
