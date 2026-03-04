/**
 * 通用输入校验工具类
 */
export class ValidationUtils {
    /**
     * 校验项目名称等标识符是否合法
     * 仅允许字母、数字和下划线，防止 SQL 注入或 Shell 注入
     */
    static isValidIdentifier(identifier: string): boolean {
        if (!identifier) return false;
        return /^[a-zA-Z0-9_]+$/.test(identifier);
    }

    /**
     * 断言标识符合法，不合法则抛错
     */
    static assertValidIdentifier(name: string, identifier: string): void {
        if (!this.isValidIdentifier(identifier)) {
            throw new Error(`Invalid identifier for ${name}: only alphanumeric characters and underscores are allowed.`);
        }
    }

    /**
     * 校验数据库名称 (允许短横线)
     */
    static isValidDbName(identifier: string): boolean {
        if (!identifier) return false;
        return /^[a-zA-Z0-9_-]+$/.test(identifier);
    }

    /**
     * 断言数据库名称合法，不合法则抛错
     */
    static assertValidDbName(name: string, identifier: string): void {
        if (!this.isValidDbName(identifier)) {
            throw new Error(`Invalid database identifier for ${name}.`);
        }
    }
}
