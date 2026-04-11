/**
 * Storage Reconciliation Worker
 * 
 * Periodically scans physical storage vs DB `storage.objects` to detect and clean
 * orphan files — physical files that exist on disk but have no corresponding DB row.
 * 
 * This addresses the gap where crashes during move/delete operations can leave
 * physical files stranded without metadata references.
 * 
 * Architecture:
 *   1. List all active projects from meta DB
 *   2. For each project, scan physical storage (JuiceFS/local) directory
 *   3. Compare against `storage.objects` table in the project's DB
 *   4. Any physical file without a DB row older than GRACE_PERIOD is an orphan
 *   5. Delete orphan files and log the cleanup
 * 
 * Runs every 6 hours by default. Only supports JuiceFS/local storage driver
 * (S3 orphans are handled by S3 lifecycle policies).
 */

import { sql as metaSql, getProjectDb } from "../db";
import { config } from "../config";
import { logger } from "../utils/logger";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// ── Configuration ────────────────────────────────────────────────
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const ORPHAN_GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours — skip files younger than this
const MAX_DELETES_PER_RUN = 500; // Safety cap to prevent runaway deletions
const DRY_RUN = process.env.STORAGE_RECONCILE_DRY_RUN === "true"; // Set to "true" to log without deleting

export interface ReconcileStats {
    projectsScanned: number;
    bucketsScanned: number;
    physicalFiles: number;
    dbObjects: number;
    orphansFound: number;
    orphansDeleted: number;
    errors: number;
    durationMs: number;
}

/**
 * Reconcile a single project's physical storage against its DB.
 */
async function reconcileProject(
    ref: string,
    dbName: string,
    stats: ReconcileStats
): Promise<void> {
    const projectRoot = path.resolve(config.storageMountPoint, `supa-${ref}`);

    // Check if the project storage directory exists
    try {
        await fs.access(projectRoot);
    } catch {
        // No physical storage directory — nothing to reconcile
        return;
    }

    // List all bucket directories
    let bucketDirs: string[];
    try {
        const entries = await fs.readdir(projectRoot, { withFileTypes: true });
        bucketDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch (e) {
        logger.warn(`[StorageReconcile] Cannot list buckets for ${ref}:`, {
            error: e instanceof Error ? e.message : String(e),
        });
        stats.errors++;
        return;
    }

    if (bucketDirs.length === 0) return;

    // Get project DB connection
    let db: ReturnType<typeof getProjectDb>;
    try {
        db = getProjectDb(dbName);
    } catch (e) {
        logger.warn(`[StorageReconcile] Cannot connect to ${dbName} for ${ref}`, {
            error: e instanceof Error ? e.message : String(e),
        });
        stats.errors++;
        return;
    }

    const now = Date.now();

    for (const bucket of bucketDirs) {
        stats.bucketsScanned++;
        const bucketPath = path.resolve(projectRoot, bucket);

        // Enumerate all physical files in this bucket
        let physicalFiles: string[];
        try {
            const { Glob } = await import("bun");
            const glob = new Glob("**/*");
            physicalFiles = Array.from(glob.scanSync({ cwd: bucketPath, onlyFiles: true }));
        } catch {
            continue; // Skip unreadable buckets
        }

        if (physicalFiles.length === 0) continue;
        stats.physicalFiles += physicalFiles.length;

        // Fetch all object names from DB for this bucket (bypass RLS — admin context)
        let dbObjectNames: Set<string>;
        try {
            const rows = await db`
                SELECT name FROM storage.objects WHERE bucket_id = ${bucket}
            `;
            dbObjectNames = new Set(rows.map((r: Record<string, unknown>) => String(r.name)));
            stats.dbObjects += dbObjectNames.size;
        } catch (e) {
            // storage.objects may not exist if project never used storage
            logger.debug(`[StorageReconcile] Cannot query storage.objects for ${ref}/${bucket}: ${e instanceof Error ? e.message : String(e)}`);
            stats.errors++;
            continue;
        }

        // Find orphans: physical files not in DB
        for (const relPath of physicalFiles) {
            if (stats.orphansDeleted >= MAX_DELETES_PER_RUN) {
                logger.warn(`[StorageReconcile] Reached max deletes cap (${MAX_DELETES_PER_RUN}), stopping early`);
                return;
            }

            if (dbObjectNames.has(relPath)) continue; // File has a DB row — not an orphan

            // Check file age to avoid race with active uploads
            const fullPath = path.resolve(bucketPath, relPath);
            try {
                const stat = await fs.stat(fullPath);
                const fileAge = now - stat.mtimeMs;
                if (fileAge < ORPHAN_GRACE_PERIOD_MS) {
                    continue; // File is too recent — might be an active upload
                }
            } catch {
                continue; // File disappeared between listing and stat
            }

            stats.orphansFound++;

            if (DRY_RUN) {
                logger.info(`[StorageReconcile] [DRY_RUN] Would delete orphan: ${ref}/${bucket}/${relPath}`);
            } else {
                try {
                    await fs.unlink(fullPath);
                    stats.orphansDeleted++;
                    logger.info(`[StorageReconcile] Deleted orphan: ${ref}/${bucket}/${relPath}`);
                } catch (e) {
                    logger.warn(`[StorageReconcile] Failed to delete orphan ${fullPath}:`, {
                        error: e instanceof Error ? e.message : String(e),
                    });
                    stats.errors++;
                }
            }
        }

        // Clean up empty directories left behind after orphan deletion
        if (stats.orphansDeleted > 0) {
            await cleanEmptyDirs(bucketPath);
        }
    }
}

/**
 * Recursively remove empty directories bottom-up.
 */
async function cleanEmptyDirs(dir: string): Promise<void> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                await cleanEmptyDirs(path.join(dir, entry.name));
            }
        }

        // Re-check after recursion
        const remaining = await fs.readdir(dir);
        if (remaining.length === 0) {
            await fs.rmdir(dir);
        }
    } catch {
        // Ignore errors during cleanup
    }
}

/**
 * Run full reconciliation across all active projects.
 */
export async function runReconciliation(): Promise<ReconcileStats> {
    const stats: ReconcileStats = {
        projectsScanned: 0,
        bucketsScanned: 0,
        physicalFiles: 0,
        dbObjects: 0,
        orphansFound: 0,
        orphansDeleted: 0,
        errors: 0,
        durationMs: 0,
    };

    // Only run for local/JuiceFS storage — S3 orphans are not our concern
    if (config.storageType !== "local" && config.storageType !== "juicefs") {
        logger.debug("[StorageReconcile] Skipped — only runs for local/JuiceFS storage drivers");
        return stats;
    }

    const start = Date.now();
    logger.info(`[StorageReconcile] Starting reconciliation scan${DRY_RUN ? " (DRY RUN)" : ""}...`);

    try {
        // Fetch all active projects
        const projects = await metaSql`
            SELECT ref, db_name FROM projects WHERE status = 'active'
        `;

        for (const project of projects) {
            const ref = String(project.ref);
            const dbName = String(project.db_name);
            stats.projectsScanned++;

            try {
                await reconcileProject(ref, dbName, stats);
            } catch (e) {
                logger.error(`[StorageReconcile] Error reconciling project ${ref}:`, {
                    error: e instanceof Error ? e.message : String(e),
                });
                stats.errors++;
            }
        }
    } catch (e) {
        logger.error(`[StorageReconcile] Fatal error during reconciliation:`, {
            error: e instanceof Error ? e.message : String(e),
        });
        stats.errors++;
    }

    stats.durationMs = Date.now() - start;

    logger.info(`[StorageReconcile] Completed in ${stats.durationMs}ms`, {
        projects: stats.projectsScanned,
        buckets: stats.bucketsScanned,
        physical: stats.physicalFiles,
        dbObjects: stats.dbObjects,
        orphansFound: stats.orphansFound,
        orphansDeleted: stats.orphansDeleted,
        errors: stats.errors,
        dryRun: DRY_RUN,
    });

    return stats;
}

// ── Lifecycle ────────────────────────────────────────────────────
let reconcileTimer: Timer | null = null;

export function startStorageReconcileWorker() {
    if (reconcileTimer) return;

    logger.info(`[StorageReconcile] Worker started (interval: ${RECONCILE_INTERVAL_MS / 3600000}h, grace: ${ORPHAN_GRACE_PERIOD_MS / 3600000}h)`);

    // First run after 5 minutes (avoid blocking bootstrap)
    const initialDelay = setTimeout(() => {
        runReconciliation().catch(e =>
            logger.error("[StorageReconcile] Unhandled error:", { error: e instanceof Error ? e.message : String(e) })
        );
    }, 5 * 60 * 1000);

    reconcileTimer = setInterval(() => {
        runReconciliation().catch(e =>
            logger.error("[StorageReconcile] Unhandled error:", { error: e instanceof Error ? e.message : String(e) })
        );
    }, RECONCILE_INTERVAL_MS);

    // Store both timers for cleanup
    (reconcileTimer as any).__initialDelay = initialDelay;
}

export function stopStorageReconcileWorker() {
    if (reconcileTimer) {
        clearInterval(reconcileTimer);
        const initialDelay = (reconcileTimer as any).__initialDelay;
        if (initialDelay) clearTimeout(initialDelay);
        reconcileTimer = null;
        logger.info("[StorageReconcile] Worker stopped");
    }
}
