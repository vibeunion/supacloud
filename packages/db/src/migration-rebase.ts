import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const MAX_MIGRATION_VERSION = 9_223_372_036_854_775_807n;

export interface RebaseMigrationInput {
  file: string;
  version: string;
  name: string;
  sql: string;
}

export interface MigrationRebasePlan {
  version: 1;
  sourceDirectory: string;
  outputDirectory: string;
  baselineFile: string;
  baselineMigration: string;
  retainedMigrations: string[];
  archivedMigrations: string[];
  sourceHistorySha256: string;
  baselineSha256: string;
  warnings: string[];
}

export interface MigrationRebaseOptions {
  sourceDirectory: string;
  outputDirectory: string;
  baselineFile: string;
  baselineVersion: string;
  baselineName?: string;
  retainAfterVersion?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedSql(value: string): string {
  return value.replace(/\r\n?/g, "\n").trimEnd() + "\n";
}

function validVersion(value: string): boolean {
  if (!/^\d{1,19}$/.test(value)) return false;
  const version = BigInt(value);
  return version > 0n && version <= MAX_MIGRATION_VERSION;
}

function migrationVersion(file: string): string {
  const match = basename(file).match(/^(\d{8,19})[_-]/);
  if (!match || !validVersion(match[1])) throw new Error(`Invalid migration version in ${file}`);
  return BigInt(match[1]).toString();
}

function migrationName(file: string): string {
  return basename(file, ".sql").replace(/^\d{8,19}[_-]/, "");
}

function sortMigrations(migrations: RebaseMigrationInput[]): RebaseMigrationInput[] {
  const sorted = [...migrations].sort((left, right) => {
    const leftVersion = BigInt(left.version);
    const rightVersion = BigInt(right.version);
    if (leftVersion !== rightVersion) return leftVersion < rightVersion ? -1 : 1;
    return left.file.localeCompare(right.file);
  });
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].version === sorted[index].version) {
      throw new Error(`Duplicate migration version ${sorted[index].version}`);
    }
  }
  return sorted;
}

export function planMigrationRebase(
  migrations: readonly RebaseMigrationInput[],
  options: Pick<MigrationRebaseOptions, "sourceDirectory" | "outputDirectory" | "baselineFile" | "baselineVersion" | "baselineName" | "retainAfterVersion">,
  baselineSql: string,
): MigrationRebasePlan {
  const sorted = sortMigrations([...migrations]);
  if (!sorted.length) throw new Error("No migration files found");
  if (!validVersion(options.baselineVersion)) throw new Error("Invalid baseline version");
  if (options.retainAfterVersion !== undefined && !validVersion(options.retainAfterVersion)) {
    throw new Error("Invalid retain-after version");
  }
  const baselineName = options.baselineName?.trim() || "reconstructed_schema";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(baselineName)) throw new Error("Invalid baseline name");
  const baselineMigration = `${options.baselineVersion}_${baselineName}.sql`;
  if (sorted.some((migration) => migration.version === options.baselineVersion)) {
    throw new Error(`Baseline version ${options.baselineVersion} collides with existing history`);
  }
  const retainAfter = options.retainAfterVersion === undefined ? null : BigInt(options.retainAfterVersion);
  const retained = sorted.filter((migration) => retainAfter !== null && BigInt(migration.version) > retainAfter);
  const archived = sorted.filter((migration) => !retained.includes(migration));
  const normalizedBaseline = normalizedSql(baselineSql);
  if (!normalizedBaseline.trim()) throw new Error("Baseline SQL is empty");
  if (!/\bCREATE\b/i.test(normalizedBaseline)) throw new Error("Baseline SQL does not look like a schema snapshot");
  const sourceHistory = sorted.map((migration) => ({
    file: migration.file,
    version: migration.version,
    name: migration.name,
    sha256: sha256(normalizedSql(migration.sql)),
  }));
  return {
    version: 1,
    sourceDirectory: options.sourceDirectory,
    outputDirectory: options.outputDirectory,
    baselineFile: options.baselineFile,
    baselineMigration,
    retainedMigrations: retained.map((migration) => migration.file),
    archivedMigrations: archived.map((migration) => migration.file),
    sourceHistorySha256: sha256(JSON.stringify(sourceHistory)),
    baselineSha256: sha256(normalizedBaseline),
    warnings: [
      "The baseline must come from a schema-only snapshot of the verified target database.",
      "Data backfills, reference data and non-replayable side effects need a separate review.",
      "Archive the old migration directory until clean replay and remote read-back have passed.",
    ],
  };
}

export async function rebaseMigrations(options: MigrationRebaseOptions): Promise<MigrationRebasePlan> {
  const sourceDirectory = resolve(options.sourceDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const baselineFile = resolve(options.baselineFile);
  if (!(await stat(sourceDirectory)).isDirectory()) throw new Error("Source migration directory is not a directory");
  if (!(await stat(baselineFile)).isFile()) throw new Error("Baseline file is not a file");
  if (sourceDirectory === outputDirectory) throw new Error("Output directory must be separate from source directory");

  const files = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const migrations = await Promise.all(files.map(async (file) => {
    const sql = await readFile(join(sourceDirectory, file), "utf8");
    return { file, version: migrationVersion(file), name: migrationName(file), sql };
  }));
  const plan = planMigrationRebase(migrations, { ...options, sourceDirectory, outputDirectory, baselineFile }, await readFile(baselineFile, "utf8"));

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, plan.baselineMigration), normalizedSql(await readFile(baselineFile, "utf8")));
  for (const migration of migrations.filter((item) => plan.retainedMigrations.includes(item.file))) {
    await writeFile(join(outputDirectory, migration.file), normalizedSql(migration.sql));
  }
  await writeFile(join(outputDirectory, "migration-rebase.manifest.json"), JSON.stringify({
    ...plan,
    generatedAt: new Date().toISOString(),
    sourceHistory: migrations.map((migration) => ({
      file: migration.file,
      version: migration.version,
      name: migration.name,
      sha256: sha256(normalizedSql(migration.sql)),
    })),
  }, null, 2) + "\n");
  return plan;
}
