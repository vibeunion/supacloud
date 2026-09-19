/** Explicit optional CONTROL-PLANE migration; never run against a tenant database. */
import { sql } from "../src/db";
import { withExpectedControlPlaneDatabaseTransaction } from "../src/db/control-plane-database-identity";
import { splitSqlStatements } from "../src/db/sql-statements";
import schema from "../src/db/task-output-journal.sql" with { type: "text" };

if (!process.argv.includes("--apply")) {
  console.error("Usage: bun run scripts/migrate-task-output-journal.ts --apply (control-plane DATABASE_URL only)");
  process.exitCode = 2;
} else {
  try {
    await withExpectedControlPlaneDatabaseTransaction(sql, async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('supacloud.task-output-journal.v1', 0))`;
      const [tables] = await transaction`
        SELECT to_regclass('public.project_tasks') IS NOT NULL
          AND to_regclass('public.projects') IS NOT NULL AS ready
      `;
      if (!tables?.ready) throw new Error("Initialize the control-plane schema before enabling task output");
      for (const statement of splitSqlStatements(schema)) await transaction.unsafe(statement);
    });
    console.log("Optional task output journal enabled; configure retention before production use.");
  } catch (error) {
    console.error("Task output migration failed", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}
await sql.close();
