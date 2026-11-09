import { enforceDatabaseGovernance } from "./database-governance-runtime";
import { assertDatabaseGovernance } from "./database-governance";

try {
  const payload: unknown = JSON.parse(await Bun.stdin.text());
  const options = payload && typeof payload === "object" && !Array.isArray(payload) && "options" in payload
    ? payload.options : payload;
  const rpcCapabilities = payload && typeof payload === "object" && !Array.isArray(payload)
    && "rpcCapabilities" in payload && Array.isArray(payload.rpcCapabilities) ? payload.rpcCapabilities : [];
  assertDatabaseGovernance(options);
  process.stdout.write(JSON.stringify(await enforceDatabaseGovernance(options, rpcCapabilities)));
} catch {
  // Imported modules and driver errors may contain credentials.
  process.stdout.write(JSON.stringify({ diagnostics: [{
    severity: "error", code: "database-governance",
    message: "Database source, module or Catalog verification failed. Check the selected project and database.",
  }] }));
}
