import { $ } from 'bun';
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { logger } from "../utils/logger";
import type { BackupInfo, RestoreRequest } from '../types/backup';
import { projectRepository } from '../repositories/project.repository';
import { resolveDbName, resolveRoleName } from '../db';


    /**
     * Get backup list
     * @param stanza Database name/instance name, defaults to db-main
     */
export async function listBackups(stanza: string = 'db-main'): Promise<BackupInfo[]> {
        let result;
        try {
            result = await Promise.race([
                $`sudo -u postgres pgbackrest --stanza=${stanza} info --output=json`.nothrow().quiet(),
                Bun.sleep(5000).then(() => null),
            ]);
        } catch {
            logger.warn('[Backup] pgbackrest command failed');
            return [];
        }
        if (result === null) {
            logger.warn('[Backup] pgbackrest command timed out after 5s');
            return [];
        }

        if (result.exitCode !== 0) {
            // Return empty list when pgbackrest is not installed
            logger.warn('[Backup] pgbackrest not available or no backups found');
            return [];
        }

        try {
            const rawData = JSON.parse(result.text());
            if (!Array.isArray(rawData) || rawData.length === 0) return [];
            const backups = rawData[0].backup || [];
            return backups.map((b: Record<string, unknown>) => ({
                id: b.label,
                type: b.type,
                timestamp: { start: (b.timestamp as Record<string, unknown>)?.start, stop: (b.timestamp as Record<string, unknown>)?.stop },
                size: ((b.info as Record<string, unknown>)?.size as Record<string, unknown>)?.backup,
                database: rawData[0].name,
            }));
        } catch (e: unknown) {
            logger.error('Failed to parse backup list:', { error: e instanceof Error ? e.message : String(e) });
            throw new Error('Failed to parse backup list');
        }
    }
export async function createBackup(stanza: string = 'db-main', type: 'full' | 'incr' | 'diff' = 'incr'): Promise<{ message: string }> {
        $`sudo -u postgres pgbackrest --stanza=${stanza} --type=${type} backup`.nothrow().quiet().catch(err => {
            logger.error('[Backup] Async backup task failed:', { error: err instanceof Error ? err.message : String(err) });
        });
        return { message: `${type} backup task started` };
    }
const PITR_TARGET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export async function restore(request: RestoreRequest): Promise<{ message: string }> {
        if (!PITR_TARGET_PATTERN.test(request.target)) {
            throw new Error("Invalid PITR target");
        }
        $`sudo -u postgres pig pitr ${request.target}`.nothrow().quiet().catch(err => {
            logger.error('[Backup] Async restore task failed:', { error: err instanceof Error ? err.message : String(err) });
        });
        return { message: `Point-in-time recovery (PITR) task started, target: ${request.target}` };
    }

const LOGICAL_BACKUP_DIR = process.env.SUPACLOUD_LOGICAL_BACKUP_DIR || "/tmp/supacloud-backups";
const LOGICAL_BACKUP_FILE_PATTERN = /^backup_[A-Za-z0-9_-]{1,64}_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sql\.gz$/;

async function ensureLogicalBackupDir(): Promise<string> {
        const baseDir = resolve(LOGICAL_BACKUP_DIR);
        await mkdir(baseDir, { recursive: true, mode: 0o700 });
        return baseDir;
    }

async function resolveLogicalBackupPath(filename: string): Promise<string> {
        if (filename !== basename(filename) || !LOGICAL_BACKUP_FILE_PATTERN.test(filename)) {
            throw new Error("Invalid backup id");
        }
        const baseDir = await ensureLogicalBackupDir();
        const fullPath = resolve(baseDir, filename);
        if (!fullPath.startsWith(`${baseDir}/`)) {
            throw new Error("Invalid backup path");
        }
        return fullPath;
    }

    /**
     * Execute logical backup per tenant level (pg_dump)
     * Export dedicated data and upload to corresponding S3 bucket
     */
export async function createLogicalBackup(projectRef: string): Promise<{ success: boolean; message: string; file?: string }> {
        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error("Project not found");

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `backup_${projectRef}_${timestamp}.sql.gz`;
        const backupPath = await resolveLogicalBackupPath(filename);

        try {
            // Use tenant role, export as Custom archive format with default gzip compression
            const tenantHost = `localhost:5432`;
            const tenantDb = await resolveDbName(projectRef);
            const tenantUser = resolveRoleName(projectRef);

            logger.info(`[LogicalBackup] Starting dump for ${projectRef} -> ${backupPath}`);
            await $`PGPASSWORD=${project.db_password} pg_dump -h localhost -p 5432 -U ${tenantUser} -d ${tenantDb} -F c -Z 6 -f ${backupPath}`.quiet();

            // Try to upload to tenant's hidden backup prefix via AWS CLI (MinIO/Garage compatible)
            if (project.s3_access_key && project.s3_secret_key) {
                try {
                    await $`AWS_ACCESS_KEY_ID=${project.s3_access_key} AWS_SECRET_ACCESS_KEY=${project.s3_secret_key} aws --endpoint-url http://localhost:9000 s3 cp ${backupPath} s3://${project.s3_bucket}/_backups/${filename}`.quiet();
                    logger.info(`[LogicalBackup] Uploaded ${filename} to S3.`);
                    await $`rm -f ${backupPath}`.quiet(); // Cleanup local after successful upload
                } catch (uploadErr: unknown) {
                    logger.warn('[LogicalBackup] S3 Upload failed (Ensure awscli is installed). Kept local copy at', backupPath);
                }
            }

            return { success: true, message: "Logical backup completed", file: filename };
        } catch (err: unknown) {
            logger.error("[LogicalBackup] failed:", { error: err instanceof Error ? err.message : String(err) });
            return { success: false, message: "Logical backup failed: " + (err instanceof Error ? err.message : String(err)) };
        }
    }

    /**
     * Execute logical restore per tenant level (pg_restore)
     */
export async function restoreLogicalBackup(projectRef: string, backupId: string): Promise<{ success: boolean; message: string }> {
        let backupPath: string;
        try {
            backupPath = await resolveLogicalBackupPath(backupId);
        } catch {
            return { success: false, message: "Invalid backup id" };
        }

        const project = await projectRepository.findByRef(projectRef);
        if (!project) throw new Error("Project not found");

        try {
            // Try downloading from S3 first
            if (project.s3_access_key && project.s3_secret_key) {
                try {
                    await $`AWS_ACCESS_KEY_ID=${project.s3_access_key} AWS_SECRET_ACCESS_KEY=${project.s3_secret_key} aws --endpoint-url http://localhost:9000 s3 cp s3://${project.s3_bucket}/_backups/${backupId} ${backupPath}`.quiet();
                    logger.info(`[LogicalBackup] Downloaded ${backupId} from S3.`);
                } catch (dlErr: unknown) {
                    logger.warn('[LogicalBackup] Could not download from S3, assuming local file exists.');
                }
            }

            // Check file exists
            const fileExists = await $`test -f ${backupPath}`.nothrow();
            if (fileExists.exitCode !== 0) {
                return { success: false, message: "Backup file not found: " + backupId };
            }

            // Execute pg_restore (force clean old objects and complete in single transaction)
            const tenantDb = await resolveDbName(projectRef);
            const tenantUser = resolveRoleName(projectRef);
            logger.info(`[LogicalBackup] Starting restore for ${projectRef} from ${backupPath}`);

            await $`PGPASSWORD=${project.db_password} pg_restore -h localhost -p 5432 -U ${tenantUser} -d ${tenantDb} -c -1 ${backupPath}`.quiet();

            logger.info(`[LogicalBackup] Restore complete for ${projectRef}`);
            return { success: true, message: "Logical restore completed successfully" };
        } catch (err: unknown) {
            logger.error("[LogicalBackup] Restore failed:", { error: err instanceof Error ? err.message : String(err) });
            return { success: false, message: "Restore process error: " + (err instanceof Error ? err.message : String(err)) };
        } finally {
            // Cleanup local temp file
            await $`rm -f ${backupPath}`.nothrow().quiet();
        }
    }

