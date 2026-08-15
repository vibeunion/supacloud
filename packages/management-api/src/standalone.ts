import pkg from "../package.json";
import { logger } from "./utils/logger";

export function isStandaloneVersionCommand(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
}

export function isSystemdUnitBrokerDigestCommand(args: string[]): boolean {
  return args.length === 1 && args[0] === "--systemd-unit-helper-sha256";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (isStandaloneVersionCommand(args)) {
    logger.info(`SupaCloud Version: ${pkg.version}`);
  } else if (isSystemdUnitBrokerDigestCommand(args)) {
    const { EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256 } = await import("./embedded-systemd-unit-broker");
    logger.info(`SupaCloud systemd-unit helper SHA-256: ${EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256}`);
  } else {
    const { startManagementApi } = await import("./index");
    startManagementApi();
  }
}
