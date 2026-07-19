import { resolve } from "node:path";
import { syncSqlModules } from "../src/db/sql-module-sync";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const check = process.argv.includes("--check");
const report = await syncSqlModules({ repositoryRoot, check });

if (report.changedFiles.length === 0) {
  console.log(check ? "SQL modules are synchronized." : "SQL modules already synchronized.");
} else {
  console.log(`Synchronized SQL modules: ${report.changedFiles.join(", ")}`);
}
