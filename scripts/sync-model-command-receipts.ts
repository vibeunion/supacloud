import { readFile, writeFile } from "node:fs/promises";
import { COMMAND_RECEIPT_SQL } from "../packages/db/src/command-schema";

const target = new URL("../packages/cli/src/shared/tools/model-command-receipts.json", import.meta.url);
const content = JSON.stringify({ generatedBy: "scripts/sync-model-command-receipts.ts", sql: COMMAND_RECEIPT_SQL }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== content) {
    throw new Error("Model command receipt SQL is stale. Run bun scripts/sync-model-command-receipts.ts");
  }
} else {
  await writeFile(target, content);
}
