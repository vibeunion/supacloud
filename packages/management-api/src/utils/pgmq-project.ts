export class PgmqProjectContextError extends Error {
  constructor() {
    super("PGMQ project database context is unavailable");
    this.name = "PgmqProjectContextError";
  }
}

export function pgmqProjectRef(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new PgmqProjectContextError();
  }
  return value;
}

export function readPgmqProjectDatabase(value: unknown, ref: string): string {
  pgmqProjectRef(ref);
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !("ref" in value) || value.ref !== ref
    || !("deleted_at" in value) || value.deleted_at !== null
    || !("db_name" in value) || typeof value.db_name !== "string") {
    throw new PgmqProjectContextError();
  }
  const database = value.db_name;
  if (database.length === 0 || database.trim() !== database
    || /[\u0000-\u001f\u007f]/.test(database)
    || new TextEncoder().encode(database).byteLength > 63) {
    throw new PgmqProjectContextError();
  }
  return database;
}
