export const CLI_HARNESS_MIGRATION_VERSION = "20990101000000";

interface RemoteMigrationRow {
  version: unknown;
}

export interface CliMigrationHistoryFixture {
  fileName: string;
  contents: string;
}

export function parseCliHarnessDatabaseUrl(databaseUrl: string): {
  dbName: string;
  dbUser: string;
  dbPassword: string;
} {
  const parsed = new URL(databaseUrl);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const dbUser = decodeURIComponent(parsed.username);
  const dbPassword = decodeURIComponent(parsed.password);

  if (!dbName || !dbUser) {
    throw new Error("CLI harness database URL must include a database name and user");
  }

  return { dbName, dbUser, dbPassword };
}

export function buildCliMigrationHistoryFixtures(
  rows: readonly RemoteMigrationRow[],
): CliMigrationHistoryFixture[] {
  const versions = new Set(rows.map((row) => String(row.version)));

  return [...versions]
    .filter((version) => version !== CLI_HARNESS_MIGRATION_VERSION)
    .sort()
    .map((version) => {
      if (!/^\d{1,19}$/.test(version)) {
        throw new Error(`Invalid remote migration version: ${version}`);
      }
      return {
        fileName: `${version}_remote_history.sql`,
        contents: `-- Existing remote migration ${version}; history fixture only.\n`,
      };
    });
}
