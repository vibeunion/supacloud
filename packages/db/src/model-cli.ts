/// <reference path="./optional-db-zenstack.d.ts" />
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { modelMain } from "@supacloud/db-zenstack/cli";

export { modelMain } from "@supacloud/db-zenstack/cli";

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { await modelMain(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Model command failed"); process.exitCode = 1; }
}
