const MAX_POSTGRES_TIMEOUT = 2_147_483_647;
const DATABASE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const DATABASE_METADATA_SETTINGS = new Set([
  "pgbouncer_enabled",
  "pgbouncer_settings",
]);

export const MUTABLE_DATABASE_SETTINGS = [
  "statement_timeout",
  "idle_in_transaction_session_timeout",
] as const;

export type MutableDatabaseSetting = (typeof MUTABLE_DATABASE_SETTINGS)[number];
export interface DatabaseConfigPatch
  extends Partial<Record<MutableDatabaseSetting, number>> {
  pgbouncer_enabled?: boolean;
  pgbouncer_settings?: Record<string, unknown>;
}

export interface LiveDatabaseSetting {
  name: string;
  setting: string;
  unit: string | null;
  context: string;
  pending_restart: boolean;
}

interface DatabaseExecutor {
  unsafe(query: string): PromiseLike<unknown>;
}

interface DatabaseSettingOverride {
  name: MutableDatabaseSetting;
  setting: string;
}

type PreviousDatabaseSettings = Record<MutableDatabaseSetting, string | null>;

interface DatabaseSettingsUpdate<T> {
  database: DatabaseExecutor;
  databaseName: string;
  patch: DatabaseConfigPatch;
  persist: () => Promise<T>;
}

interface DatabaseSettingRestoreFailure {
  name: MutableDatabaseSetting;
  error: unknown;
}

interface PreparedDatabaseSettings {
  previousSettings: PreviousDatabaseSettings;
  settingNames: MutableDatabaseSetting[];
}

export type DatabaseSettingsUpdateResult<T> =
  | { ok: true; persisted: T }
  | {
      ok: false;
      stage: "apply" | "persist";
      error: unknown;
      restoreAttempted: boolean;
      restoreFailures: DatabaseSettingRestoreFailure[];
    };

export class DatabaseConfigValidationError extends Error {
  constructor(
    public readonly code: "INVALID_SETTING_SCOPE" | "INVALID_DATABASE_SETTING",
    message: string,
  ) {
    super(message);
    this.name = "DatabaseConfigValidationError";
  }
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function parseTimeout(name: string, input: unknown): number {
  // Boundary: accepts 0 and int32 max; rejects negative numbers, out-of-range, non-integers, and non-numeric strings.
  const parsed = typeof input === "string" && /^\d+$/.test(input)
    ? Number(input)
    : input;
  if (
    typeof parsed !== "number"
    || !Number.isInteger(parsed)
    || parsed < 0
    || parsed > MAX_POSTGRES_TIMEOUT
  ) {
    throw new DatabaseConfigValidationError(
      "INVALID_DATABASE_SETTING",
      `${name} must be an integer between 0 and ${MAX_POSTGRES_TIMEOUT}`,
    );
  }
  return parsed;
}

function assertSupportedPatchKeys(body: Record<string, unknown>): void {
  const settingNames = Object.keys(body);
  const unknownSetting = settingNames.find(
    (name) =>
      !MUTABLE_DATABASE_SETTINGS.includes(name as MutableDatabaseSetting)
      && !DATABASE_METADATA_SETTINGS.has(name),
  );
  if (!unknownSetting && settingNames.length > 0) return;
  throw new DatabaseConfigValidationError(
    "INVALID_DATABASE_SETTING",
    unknownSetting
      ? `Unsupported database setting: ${unknownSetting}`
      : "At least one supported database setting is required",
  );
}

function pgbouncerEnabledPatch(
  body: Record<string, unknown>,
): Pick<DatabaseConfigPatch, "pgbouncer_enabled"> {
  if (!hasOwn(body, "pgbouncer_enabled")) return {};
  if (typeof body.pgbouncer_enabled !== "boolean") {
    throw new DatabaseConfigValidationError(
      "INVALID_DATABASE_SETTING",
      "pgbouncer_enabled must be a boolean",
    );
  }
  return { pgbouncer_enabled: body.pgbouncer_enabled };
}

function pgbouncerSettingsPatch(
  body: Record<string, unknown>,
): Pick<DatabaseConfigPatch, "pgbouncer_settings"> {
  if (!hasOwn(body, "pgbouncer_settings")) return {};
  const settings = body.pgbouncer_settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new DatabaseConfigValidationError(
      "INVALID_DATABASE_SETTING",
      "pgbouncer_settings must be an object",
    );
  }
  return { pgbouncer_settings: settings as Record<string, unknown> };
}

export function parseDatabaseConfigPatch(
  body: Record<string, unknown>,
): DatabaseConfigPatch {
  if (hasOwn(body, "max_connections")) {
    throw new DatabaseConfigValidationError(
      "INVALID_SETTING_SCOPE",
      "max_connections is an instance-level setting and cannot be changed per project",
    );
  }
  assertSupportedPatchKeys(body);
  const patch: DatabaseConfigPatch = {
    ...pgbouncerEnabledPatch(body),
    ...pgbouncerSettingsPatch(body),
  };
  for (const name of MUTABLE_DATABASE_SETTINGS) {
    if (hasOwn(body, name)) patch[name] = parseTimeout(name, body[name]);
  }
  return patch;
}

export function quoteDatabaseIdentifier(databaseName: string): string {
  if (
    !DATABASE_IDENTIFIER_PATTERN.test(databaseName)
    || Buffer.byteLength(databaseName, "utf8") > 63
  ) {
    throw new Error("Invalid PostgreSQL database identifier");
  }
  return `"${databaseName}"`;
}

function rowsFromQuery(queryResult: unknown): Record<string, unknown>[] {
  if (!Array.isArray(queryResult)) {
    throw new Error("PostgreSQL settings query returned an invalid result");
  }
  return queryResult as Record<string, unknown>[];
}

function liveSettingFromRow(row: Record<string, unknown>): LiveDatabaseSetting {
  if (
    typeof row.name !== "string"
    || typeof row.setting !== "string"
    || typeof row.context !== "string"
    || typeof row.pending_restart !== "boolean"
  ) {
    throw new Error("PostgreSQL settings query returned an invalid row");
  }
  return {
    name: row.name,
    setting: row.setting,
    unit: typeof row.unit === "string" ? row.unit : null,
    context: row.context,
    pending_restart: row.pending_restart,
  };
}

export async function readLiveDatabaseSettings(
  database: DatabaseExecutor,
): Promise<LiveDatabaseSetting[]> {
  const queryResult = await database.unsafe(`
    SELECT name, setting, unit, context, pending_restart
    FROM pg_settings
    WHERE name IN ('max_connections', 'statement_timeout', 'idle_in_transaction_session_timeout')
    ORDER BY name
  `);
  return rowsFromQuery(queryResult).map(liveSettingFromRow);
}

export function liveSettingNumber(
  settings: LiveDatabaseSetting[],
  name: string,
): number | null {
  const setting = settings.find((candidate) => candidate.name === name)?.setting;
  if (setting === undefined) return null;
  const numericSetting = Number(setting);
  return Number.isFinite(numericSetting) ? numericSetting : null;
}

function emptyPreviousSettings(): PreviousDatabaseSettings {
  return {
    statement_timeout: null,
    idle_in_transaction_session_timeout: null,
  };
}

function settingOverrideFromRow(
  row: Record<string, unknown>,
): DatabaseSettingOverride | null {
  if (
    !MUTABLE_DATABASE_SETTINGS.includes(row.name as MutableDatabaseSetting)
    || typeof row.setting !== "string"
  ) return null;
  return {
    name: row.name as MutableDatabaseSetting,
    setting: row.setting,
  };
}

async function readDatabaseSettingOverrides(
  database: DatabaseExecutor,
): Promise<PreviousDatabaseSettings> {
  const queryResult = await database.unsafe(`
    SELECT split_part(entry, '=', 1) AS name,
           substr(entry, strpos(entry, '=') + 1) AS setting
    FROM pg_db_role_setting
    CROSS JOIN LATERAL unnest(setconfig) AS entry
    WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND setrole = 0
      AND split_part(entry, '=', 1) IN ('statement_timeout', 'idle_in_transaction_session_timeout')
  `);
  const previousSettings = emptyPreviousSettings();
  for (const row of rowsFromQuery(queryResult)) {
    const settingOverride = settingOverrideFromRow(row);
    if (settingOverride) previousSettings[settingOverride.name] = settingOverride.setting;
  }
  return previousSettings;
}

function requestedSettingNames(patch: DatabaseConfigPatch): MutableDatabaseSetting[] {
  return MUTABLE_DATABASE_SETTINGS.filter((name) => patch[name] !== undefined);
}

function quoteSettingLiteral(setting: string): string {
  return `'${setting.replaceAll("'", "''")}'`;
}

function restoreStatement(
  databaseName: string,
  name: MutableDatabaseSetting,
  previousSetting: string | null,
): string {
  const target = `ALTER DATABASE ${quoteDatabaseIdentifier(databaseName)}`;
  return previousSetting === null
    ? `${target} RESET ${name}`
    : `${target} SET ${name} = ${quoteSettingLiteral(previousSetting)}`;
}

async function restoreDatabaseSettings(
  database: DatabaseExecutor,
  databaseName: string,
  previousSettings: PreviousDatabaseSettings,
  names: MutableDatabaseSetting[],
): Promise<DatabaseSettingRestoreFailure[]> {
  const failures: DatabaseSettingRestoreFailure[] = [];
  for (const name of names) {
    try {
      await database.unsafe(restoreStatement(databaseName, name, previousSettings[name]));
    } catch (error: unknown) {
      failures.push({ name, error });
    }
  }
  return failures;
}

async function applyRequestedSettings(
  database: DatabaseExecutor,
  databaseName: string,
  patch: DatabaseConfigPatch,
  previousSettings: PreviousDatabaseSettings,
): Promise<
  Extract<DatabaseSettingsUpdateResult<never>, { ok: false }> | null
> {
  const appliedNames: MutableDatabaseSetting[] = [];
  for (const name of requestedSettingNames(patch)) {
    try {
      await database.unsafe(
        `ALTER DATABASE ${quoteDatabaseIdentifier(databaseName)} SET ${name} = ${patch[name]}`,
      );
      appliedNames.push(name);
    } catch (error: unknown) {
      const restoreNames = [...appliedNames, name];
      const restoreFailures = await restoreDatabaseSettings(
        database,
        databaseName,
        previousSettings,
        restoreNames,
      );
      return {
        ok: false,
        stage: "apply",
        error,
        restoreAttempted: true,
        restoreFailures,
      };
    }
  }
  return null;
}

async function prepareDatabaseSettings(
  input: DatabaseSettingsUpdate<unknown>,
): Promise<
  | { ok: true; prepared: PreparedDatabaseSettings }
  | Extract<DatabaseSettingsUpdateResult<never>, { ok: false }>
> {
  const settingNames = requestedSettingNames(input.patch);
  if (settingNames.length === 0) {
    return {
      ok: true,
      prepared: { previousSettings: emptyPreviousSettings(), settingNames },
    };
  }
  try {
    quoteDatabaseIdentifier(input.databaseName);
    const previousSettings = await readDatabaseSettingOverrides(input.database);
    const applyFailure = await applyRequestedSettings(
      input.database,
      input.databaseName,
      input.patch,
      previousSettings,
    );
    return applyFailure || {
      ok: true,
      prepared: { previousSettings, settingNames },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      stage: "apply",
      error,
      restoreAttempted: false,
      restoreFailures: [],
    };
  }
}

async function persistDatabaseSettings<T>(
  input: DatabaseSettingsUpdate<T>,
  prepared: PreparedDatabaseSettings,
): Promise<DatabaseSettingsUpdateResult<T>> {
  try {
    return { ok: true, persisted: await input.persist() };
  } catch (error: unknown) {
    const restoreFailures = await restoreDatabaseSettings(
      input.database,
      input.databaseName,
      prepared.previousSettings,
      prepared.settingNames,
    );
    return {
      ok: false,
      stage: "persist",
      error,
      restoreAttempted: prepared.settingNames.length > 0,
      restoreFailures,
    };
  }
}

export async function updateDatabaseSettings<T>(
  input: DatabaseSettingsUpdate<T>,
): Promise<DatabaseSettingsUpdateResult<T>> {
  const preparation = await prepareDatabaseSettings(input);
  if (!preparation.ok) return preparation;
  return persistDatabaseSettings(input, preparation.prepared);
}
