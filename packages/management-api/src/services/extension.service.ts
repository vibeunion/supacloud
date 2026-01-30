import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);
const EXTENSION_MANAGER_PATH = path.resolve(process.cwd(), '../../scripts/lib/extension_manager.sh');

export interface ExtensionInfo {
    name: string;
    default_version: string;
    installed_version: string | null;
    comment: string;
    is_installed: boolean;
}

export class ExtensionService {
    /**
     * 获取项目的扩展列表
     * @param projectRef 项目标识
     */
    static async listExtensions(projectRef: string): Promise<ExtensionInfo[]> {
        const dbName = `supa_${projectRef}`;
        try {
            const { stdout } = await execAsync(`bash ${EXTENSION_MANAGER_PATH} list ${dbName}`);
            return JSON.parse(stdout || '[]');
        } catch (error) {
            console.error(`Failed to list extensions for ${projectRef}:`, error);
            throw new Error('无法获取插件列表');
        }
    }

    /**
     * 启用扩展
     */
    static async enableExtension(projectRef: string, extension: string): Promise<{ message: string }> {
        const dbName = `supa_${projectRef}`;
        try {
            await execAsync(`bash ${EXTENSION_MANAGER_PATH} enable ${dbName} "${extension}"`);
            return { message: `插件 ${extension} 已成功启用` };
        } catch (error) {
            console.error(`Failed to enable extension ${extension}:`, error);
            throw new Error(`启用插件 ${extension} 失败`);
        }
    }

    /**
     * 禁用扩展
     */
    static async disableExtension(projectRef: string, extension: string): Promise<{ message: string }> {
        const dbName = `supa_${projectRef}`;
        try {
            await execAsync(`bash ${EXTENSION_MANAGER_PATH} disable ${dbName} "${extension}"`);
            return { message: `插件 ${extension} 已成功禁用` };
        } catch (error) {
            console.error(`Failed to disable extension ${extension}:`, error);
            throw new Error(`禁用插件 ${extension} 失败`);
        }
    }
}
