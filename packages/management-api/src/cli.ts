/**
 * SupaCloud Management CLI
 * 
 * Provides utility commands for cluster administrators.
 */
import { logger } from "./utils/logger";
import { config as appConfig } from "./config";
import { gatewayService } from "./services/gateway.service";

async function setupStudioDomain(domain: string) {
  if (!domain) {
    logger.error("Usage: bun run src/cli.ts setup-studio-domain <domain>");
    process.exit(1);
  }

  const STUDIO_INTERNAL = appConfig.studioInternal;
  
  logger.info(`Provisioning global Studio & Management API through ${gatewayService.name} gateway for domain ${domain}...`);

  try {
    const studioPort = Number(STUDIO_INTERNAL.split(":").pop() || "3000");
    await gatewayService.withDeferredPersist(async () => {
      await gatewayService.setupMasterRoutes();
      await gatewayService.configureStudioDomain(domain, studioPort);
    });

    logger.info(`\n\nSuccessfully bound Global Studio to: https://${domain}`);
    logger.info(`Make sure to point your DNS A record for ${domain} to this server's IP address.\n`);
  } catch (error: unknown) {
    logger.error(`Failed to bind global domain: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
SupaCloud CLI

Usage:
  bun run src/cli.ts <command> [args]

Available Commands:
  setup-studio-domain <domain>   Bind a global custom domain to the SupaCloud Studio & API
    `);
    process.exit(0);
  }

  switch (command) {
    case "setup-studio-domain":
      await setupStudioDomain(args[1]);
      break;
    default:
      logger.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(err => {
  logger.error(err);
  process.exit(1);
});
