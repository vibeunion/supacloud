import {
  CompiledQuery, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type DatabaseConnection, type Dialect, type Driver, type Kysely,
  type QueryResult, type TransactionSettings,
} from "kysely";

/** The narrow native transport contract also permits deterministic driver tests. */
export interface BunSqlRows extends ReadonlyArray<unknown> {
  readonly command?: string;
  readonly count?: number;
}
export interface BunSqlConnection {
  unsafe(text: string, parameters: unknown[]): PromiseLike<BunSqlRows>;
  release(): void;
}
export interface BunSqlPool {
  reserve(): Promise<BunSqlConnection>;
  close(): Promise<void>;
}

class Connection implements DatabaseConnection {
  private active = true;
  constructor(private readonly native: BunSqlConnection) {}
  async executeQuery<Row>(query: CompiledQuery): Promise<QueryResult<Row>> {
    if (!this.active) throw new Error("Database connection is released");
    const result = await this.native.unsafe(query.sql, [...query.parameters]);
    // Kysely's driver boundary transports rows; application/ORM decoders own validation.
    const rows = Array.from(result) as Row[];
    const affected = /^(INSERT|UPDATE|DELETE|MERGE)$/.test(result.command ?? "") && result.count !== undefined;
    return { rows, ...(affected ? { numAffectedRows: BigInt(result.count!) } : {}) };
  }
  async *streamQuery<Row>(): AsyncIterableIterator<QueryResult<Row>> {
    throw new Error("Bun SQL cursor streaming is not supported by this dialect");
  }
  release(): void {
    if (!this.active) return;
    this.active = false;
    this.native.release();
  }
}

const isolationLevels = new Set(["read uncommitted", "read committed", "repeatable read", "serializable"]);
function savepointName(name: string): string {
  if (!name || name.includes("\0")) throw new Error("Invalid savepoint name");
  return `"${name.replaceAll('"', '""')}"`;
}

/** One reserved connection per Kysely transaction; never calls pool.begin(). */
class BunSqlDriver implements Driver {
  constructor(private readonly pool: BunSqlPool, private readonly closePool: boolean) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> { return new Connection(await this.pool.reserve()); }
  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    if (settings.isolationLevel && !isolationLevels.has(settings.isolationLevel)) throw new Error("Unsupported PostgreSQL isolation level");
    if (settings.accessMode && !["read only", "read write"].includes(settings.accessMode)) throw new Error("Invalid transaction access mode");
    const isolation = settings.isolationLevel ? ` ISOLATION LEVEL ${settings.isolationLevel}` : "";
    const access = settings.accessMode ? ` ${settings.accessMode}` : "";
    await connection.executeQuery(CompiledQuery.raw(`BEGIN${isolation}${access}`));
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> { await connection.executeQuery(CompiledQuery.raw("COMMIT")); }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> { await connection.executeQuery(CompiledQuery.raw("ROLLBACK")); }
  async savepoint(connection: DatabaseConnection, name: string): Promise<void> { await connection.executeQuery(CompiledQuery.raw(`SAVEPOINT ${savepointName(name)}`)); }
  async rollbackToSavepoint(connection: DatabaseConnection, name: string): Promise<void> { await connection.executeQuery(CompiledQuery.raw(`ROLLBACK TO SAVEPOINT ${savepointName(name)}`)); }
  async releaseSavepoint(connection: DatabaseConnection, name: string): Promise<void> { await connection.executeQuery(CompiledQuery.raw(`RELEASE SAVEPOINT ${savepointName(name)}`)); }
  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    if (!(connection instanceof Connection)) throw new Error("Connection belongs to another dialect");
    connection.release();
  }
  async destroy(): Promise<void> { if (this.closePool) await this.pool.close(); }
}

/** PostgreSQL compiler/adapter are upstream Kysely; only the native driver is local. */
export class BunPostgresDialect implements Dialect {
  constructor(private readonly pool: BunSqlPool, private readonly options: { closePool?: boolean } = {}) {}
  createDriver(): Driver { return new BunSqlDriver(this.pool, this.options.closePool === true); }
  createAdapter(): PostgresAdapter { return new PostgresAdapter(); }
  createQueryCompiler(): PostgresQueryCompiler { return new PostgresQueryCompiler(); }
  createIntrospector(db: Kysely<unknown>): PostgresIntrospector { return new PostgresIntrospector(db); }
}
