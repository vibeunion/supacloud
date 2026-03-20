import { SQL } from "bun";
import { $ } from "bun";

export interface ExtensionInfo {
    name: string;
    default_version: string;
    installed_version: string | null;
    comment: string;
    is_installed: boolean;
}

export class ExtensionService {
    private readonly PG_HOST = process.env.PG_HOST || process.env.POSTGRES_HOST || "localhost";
    private readonly PG_PORT = parseInt(process.env.PG_PORT || process.env.POSTGRES_PORT || "5432");
    private readonly PG_USER = process.env.PG_USER || "postgres";
    private readonly PG_PASSWORD = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "postgres";

    private getTenantDb(dbName: string): SQL {
        return new SQL({
            hostname: this.PG_HOST,
            port: this.PG_PORT,
            database: dbName,
            username: this.PG_USER,
            password: this.PG_PASSWORD,
        });
    }

    /**
     * Get extension list for project (direct query to pg_available_extensions)
     */
    async listExtensions(projectRef: string): Promise<ExtensionInfo[]> {
        const dbName = `supa_${projectRef}`;
        const db = this.getTenantDb(dbName);
        try {
            const rows = await db`
                SELECT
                    name,
                    default_version,
                    installed_version,
                    comment,
                    installed_version IS NOT NULL AS is_installed
                FROM pg_available_extensions
                ORDER BY name
            `;
            return rows as ExtensionInfo[];
        } finally {
            await db.close();
        }
    }

    /**
     * Enable extension (direct CREATE EXTENSION)
     */
    async enableExtension(projectRef: string, extension: string): Promise<{ message: string }> {
        const dbName = `supa_${projectRef}`;
        const db = this.getTenantDb(dbName);
        try {
            await db.unsafe(`CREATE EXTENSION IF NOT EXISTS "${extension}" CASCADE`);
            return { message: `Extension ${extension} enabled successfully` };
        } finally {
            await db.close();
        }
    }

    /**
     * Disable extension (direct DROP EXTENSION)
     */
    async disableExtension(projectRef: string, extension: string): Promise<{ message: string }> {
        const dbName = `supa_${projectRef}`;
        const db = this.getTenantDb(dbName);
        try {
            await db.unsafe(`DROP EXTENSION IF EXISTS "${extension}" CASCADE`);
            return { message: `Extension ${extension} disabled successfully` };
        } finally {
            await db.close();
        }
    }

    // ─── System-level extension management (Pigsty pig ext) ───

    /**
     * List all extensions available to install via pig/pigsty package manager
     */
    async listSystemExtensions(): Promise<{ name: string; version: string; status: string; description: string }[]> {
        try {
            const result = await $`pig ext list`.nothrow().quiet();
            if (result.exitCode !== 0) {
                // Fallback: try dpkg/rpm to list installed pg extensions
                const fallback = await $`dpkg -l 'postgresql-*' 2>/dev/null || rpm -qa 'postgresql*' 2>/dev/null || echo ''`.nothrow().quiet();
                return [{ name: 'pig-not-available', version: '-', status: 'unavailable', description: 'pig CLI not found, install pigsty first' }];
            }
            const lines = result.text().split('\n').filter((l: string) => l.trim() && !l.startsWith('#') && !l.startsWith('='));
            return lines.map((line: string) => {
                const parts = line.split(/\s+/);
                return {
                    name: parts[0] || '',
                    version: parts[1] || '',
                    status: parts[2] || 'available',
                    description: parts.slice(3).join(' ') || '',
                };
            }).filter((e: { name: string }) => e.name);
        } catch {
            return [];
        }
    }

    /**
     * Install an extension package at OS level via pig ext
     */
    async installSystemExtension(name: string): Promise<{ success: boolean; message: string }> {
        try {
            const result = await $`sudo pig ext install ${name} -y`.nothrow().quiet();
            if (result.exitCode !== 0) {
                return { success: false, message: `Failed to install ${name}: ${result.stderr.toString().slice(0, 500)}` };
            }
            return { success: true, message: `Extension package '${name}' installed successfully` };
        } catch (err: any) {
            return { success: false, message: err.message };
        }
    }

    /**
     * Remove an extension package at OS level via pig ext
     */
    async removeSystemExtension(name: string): Promise<{ success: boolean; message: string }> {
        try {
            const result = await $`sudo pig ext remove ${name} -y`.nothrow().quiet();
            if (result.exitCode !== 0) {
                return { success: false, message: `Failed to remove ${name}: ${result.stderr.toString().slice(0, 500)}` };
            }
            return { success: true, message: `Extension package '${name}' removed successfully` };
        } catch (err: any) {
            return { success: false, message: err.message };
        }
    }
}

export const extensionService = new ExtensionService();
