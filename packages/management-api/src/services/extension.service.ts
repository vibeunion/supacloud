import { shellService } from './shell.service';

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
        const { success, output, error } = await shellService.execute('extension_manager.sh', ['list', dbName]);

        if (!success) {
            console.error(`Failed to list extensions for ${projectRef}:`, error);
            throw new Error('无法获取插件列表');
        }

        try {
            return JSON.parse(output || '[]');
        } catch (e) {
            console.error(`Failed to parse extensions for ${projectRef}:`, e);
            throw new Error('解析插件列表失败');
        }
    }

    /**
     * 启用扩展
     */
    static async enableExtension(projectRef: string, extension: string): Promise<{ message: string }> {
        const dbName = `supa_${projectRef}`;
        const { success, error } = await shellService.execute('extension_manager.sh', ['enable', dbName, extension]);

        if (!success) {
            console.error(`Failed to enable extension ${extension}:`, error);
            throw new Error(`启用插件 ${extension} 失败`);
        }

        return { message: `插件 ${extension} 已成功启用` };
    }

    /**
     * 禁用扩展
     */
    static async disableExtension(projectRef: string, extension: string): Promise<{ message: string }> {
        const dbName = `supa_${projectRef}`;
        const { success, error } = await shellService.execute('extension_manager.sh', ['disable', dbName, extension]);

        if (!success) {
            console.error(`Failed to disable extension ${extension}:`, error);
            throw new Error(`禁用插件 ${extension} 失败`);
        }

        return { message: `插件 ${extension} 已成功禁用` };
    }
}
