import { enforceDatabaseGovernance } from "./database-governance-runtime";
import { assertDatabaseGovernance } from "./database-governance";

try {
  const options: unknown = JSON.parse(await Bun.stdin.text());
  assertDatabaseGovernance(options);
  process.stdout.write(JSON.stringify(await enforceDatabaseGovernance(options)));
} catch {
  // Imported modules and driver errors may contain credentials.
  process.stdout.write(JSON.stringify({ diagnostics: [{
    severity: "error", code: "database-governance",
    message: "Database source, module or Catalog verification failed. Check the selected project and database.",
  }] }));
}
