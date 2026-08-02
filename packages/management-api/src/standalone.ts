import pkg from "../package.json";
import { logger } from "./utils/logger";

export function isStandaloneVersionCommand(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (isStandaloneVersionCommand(args)) {
    logger.info(`SupaCloud Version: ${pkg.version}`);
  } else {
    const { startManagementApi } = await import("./index");
    startManagementApi();
  }
}
