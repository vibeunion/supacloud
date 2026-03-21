/**
 * 通用输入校验工具
 */

/**
 * 校验项目名称等标识符是否合法
 * 仅允许字母、数字和下划线，防止 SQL 注入或 Shell 注入
 */
export function isValidIdentifier(identifier: string): boolean {
    if (!identifier) return false;
    return /^[a-zA-Z0-9_]+$/.test(identifier);
}

/**
 * 断言标识符合法，不合法则抛错
 */
export function assertValidIdentifier(name: string, identifier: string): void {
    if (!isValidIdentifier(identifier)) {
        throw new Error(`Invalid identifier for ${name}: only alphanumeric characters and underscores are allowed.`);
    }
}

/**
 * 校验数据库名称 (允许短横线)
 */
export function isValidDbName(identifier: string): boolean {
    if (!identifier) return false;
    return /^[a-zA-Z0-9_-]+$/.test(identifier);
}

/**
 * 断言数据库名称合法，不合法则抛错
 */
export function assertValidDbName(name: string, identifier: string): void {
    if (!isValidDbName(identifier)) {
        throw new Error(`Invalid database identifier for ${name}.`);
    }
}
