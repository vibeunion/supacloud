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

  const MANAGEMENT_API_INTERNAL = appConfig.managementApiInternal;
  const STUDIO_INTERNAL = appConfig.studioInternal;
  
  logger.info(`Provisioning global Studio & Management API in Native Kong for domain ${domain}...`);

  try {
    // 1. Management API Services
    await gatewayService['kongRequest']('/services/svc-global-management', 'PUT', {
      name: 'svc-global-management',
      url: `http://${MANAGEMENT_API_INTERNAL}`,
    });
    
    // Management Auth & Platform Routes
    await gatewayService['kongRequest']('/routes/route-global-management', 'PUT', {
       name: 'route-global-management',
       service: { name: 'svc-global-management' },
       paths: ['/api/platform/', '/api/auth/'],
       hosts: [domain],
       strip_path: false,
       preserve_host: true
    });

    // 2. Studio SPA frontend
    await gatewayService['kongRequest']('/services/svc-global-studio', 'PUT', {
      name: 'svc-global-studio',
      url: `http://${STUDIO_INTERNAL}`,
    });

    // Studio Root path
    await gatewayService['kongRequest']('/routes/route-global-studio', 'PUT', {
       name: 'route-global-studio',
       service: { name: 'svc-global-studio' },
       paths: ['/'],
       hosts: [domain],
       strip_path: false,
       preserve_host: true
    });

    logger.info(`\n\n✅ Successfully bound Global Studio to: https://${domain}`);
    logger.info(`Make sure to point your DNS A record for ${domain} to this server's IP address.\n`);
  } catch (error: any) {
    logger.error(`Failed to bind global domain: ${error.message}`);
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
