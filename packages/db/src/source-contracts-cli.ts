#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { databaseSources } from "./source-contracts";

export async function databaseSourcesMain(args: string[]): Promise<number> {
  const [action, flag, root] = args;
  if (!["assess", "check", "generate"].includes(action ?? "") || (args.length !== 1
    && (args.length !== 3 || flag !== "--root" || !root || root.startsWith("-")))) {
    throw new Error("Usage: supacloud-db <assess|check|generate> [--root project]");
  }
  if (action !== "assess" && action !== "check" && action !== "generate") throw new Error("Invalid action");
  const report = await databaseSources(root ?? ".", action);
  console.log(JSON.stringify(report, null, 2));
  return action === "assess" || report.ok ? 0 : 1;
}

if (process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await databaseSourcesMain(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Database source check failed");
    process.exitCode = 1;
  }
}
