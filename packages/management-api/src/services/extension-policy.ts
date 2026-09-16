export class ExtensionOperationError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 409 = 409,
    ) {
        super(message);
        this.name = "ExtensionOperationError";
    }
}

export function extensionIdentifier(name: string): string {
    // Extension names may contain hyphens (for example uuid-ossp).
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(name)) {
        throw new ExtensionOperationError(`Invalid extension name: ${name}`, 400);
    }
    return name;
}

export function assertExtensionMutation(name: string, enabling: boolean): void {
    if (name === "pgflow") {
        throw new ExtensionOperationError(
            "pgflow is a SQL workflow component, not a CREATE EXTENSION package. Install its reviewed migrations and deploy its workers; pause/resume workers separately without dropping the pgflow schema.",
        );
    }
    if (!enabling && ["pg_durable", "pgmq", "pg_cron", "pg_net", "supabase_vault", "pgsodium", "timescaledb"].includes(name)) {
        throw new ExtensionOperationError(
            `${name} may own persistent data, secrets or scheduled work. Removing it requires a reviewed backup and migration, not the extension toggle.`,
        );
    }
}

export function extensionOperationFailure(error: unknown): { status: 400 | 409; message: string } | null {
    if (error instanceof ExtensionOperationError) return { status: error.status, message: error.message };
    if (typeof error !== "object" || error === null || !("code" in error)) return null;
    if (error.code === "2BP01") {
        return { status: 409, message: "Extension is still in use. Remove or migrate dependent objects explicitly before disabling it. No dependencies were deleted." };
    }
    if (error.code === "58P01" || error.code === "0A000" || error.code === "55000") {
        return { status: 409, message: "Extension prerequisites are not ready. Check the installed package, PostgreSQL version, preload configuration and required restart." };
    }
    return null;
}
