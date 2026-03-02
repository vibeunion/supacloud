import { SQL } from "bun";

export interface ExtensionInfo {
    name: string;
    default_version: string;
    installed_version: string | null;
    comment: string;
    is_installed: boolean;
}

export class ExtensionService {
    private readonly PG_HOST = process.env.PG_HOST || process.env.POSTGRES_HOST || "localhost";
    private readonly PG_PORT = parseInt(process.env.PG_PORT || process.env.POSTGRES_PORT || "6432");
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
     * 获取项目的扩展列表（直接查询 pg_available_extensions）
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
     * 启用扩展（直接 CREATE EXTENSION）
     */
    async enableExtension(projectRef: string, extension: string): Promise<{ message: string }> {
        const dbName = `supa_${projectRef}`;
        const db = this.getTenantDb(dbName);
        try {
            await db.unsafe(`CREATE EXTENSION IF NOT EXISTS "${extension}" CASCADE`);
            return { message: `插件 ${extension} 已成功启用` };
        } finally {
            await db.close();
        }
    }

    /**
     * 禁用扩展（直接 DROP EXTENSION）
     */
    async disableExtension(projectRef: string, extension: string): Promise<{ message: string }> {
        const dbName = `supa_${projectRef}`;
        const db = this.getTenantDb(dbName);
        try {
            await db.unsafe(`DROP EXTENSION IF EXISTS "${extension}" CASCADE`);
            return { message: `插件 ${extension} 已成功禁用` };
        } finally {
            await db.close();
        }
    }
}

export const extensionService = new ExtensionService();
