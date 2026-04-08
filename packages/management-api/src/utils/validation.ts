/**
 * General input validation utilities
 */

/**
 * Validate whether identifiers like project names are valid
 * Only allow letters, numbers, and underscores to prevent SQL or Shell injection
 */
export function isValidIdentifier(identifier: string): boolean {
    if (!identifier) return false;
    return /^[a-zA-Z0-9_]+$/.test(identifier);
}

/**
 * Assert that the identifier is valid, throw error if invalid
 */
export function assertValidIdentifier(name: string, identifier: string): void {
    if (!isValidIdentifier(identifier)) {
        throw new Error(`Invalid identifier for ${name}: only alphanumeric characters and underscores are allowed.`);
    }
}

/**
 * Validate database name (allow hyphens)
 */
export function isValidDbName(identifier: string): boolean {
    if (!identifier) return false;
    return /^[a-zA-Z0-9_-]+$/.test(identifier);
}

/**
 * Assert that the database name is valid, throw error if invalid
 */
export function assertValidDbName(name: string, identifier: string): void {
    if (!isValidDbName(identifier)) {
        throw new Error(`Invalid database identifier for ${name}.`);
    }
}
