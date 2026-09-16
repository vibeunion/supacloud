import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadMigrations } from "../../worker/scripts/migrations";
const migrations = (await loadMigrations("shared")).map(migration => ({
  ...migration, sha256: createHash("sha256").update(migration.sql).digest("hex"),
}));
const source = "// Generated from the canonical packages/worker shared profile; do not edit.\n"
  + `export const PGFLOW_MIGRATIONS = ${JSON.stringify(migrations, null, 2)} as const;\n`;
const target = new URL("../src/db/pgflow-bundle.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== source) throw new Error("PGFLOW_BUNDLE_STALE");
} else writeFileSync(target, source);
